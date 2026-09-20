# Governance & Security

Two related pieces of work, documented together because a customer security
review asks about both in the same meeting:

1. **Governance** — a policy engine that evaluates the multi-cloud estate
   against rules the customer configures, scores the result, and enforces the
   rules it has been told to enforce.
2. **Platform hardening** — the protections Cloudwise itself runs with, given it
   holds credentials to that estate.

---

## 1. Governance

### What it is

A tenant-configurable set of policies evaluated on a schedule against data
already in the product (`cost_facts`, `resource_inventory`, `cloud_accounts`,
`budgets`, `anomaly_events`, `users`, `agent_config`).

No new credentials and no new IAM permissions. The one place it reaches a cloud
API is the inventory sync before each sweep, and that uses the same read calls
inventory collection has always made — `DescribeInstances`, `DescribeVolumes`,
`DescribeDBInstances` — keeping the security attributes those responses already
returned instead of discarding them.

### Shape of the design

```
shared/governance.ts          vocabulary shared with the browser
server/governance/
  catalog.ts                  the policies — pure functions, no I/O
  types.ts                    the contract a policy implements
  data.ts                     one dataset per sweep, aggregated in Postgres
  scope.ts                    provider/account/region/tag narrowing
  assignments.ts              catalog defaults merged with tenant overrides
  scoring.ts                  severity-weighted posture score
  engine.ts                   the sweep: evaluate, reconcile, score, audit
  inventory-sync.ts           refreshes resource_inventory before a sweep
  routes.ts                   the API
  scheduler.ts                periodic evaluation, one replica at a time
```

**Policies are code, not rows.** A policy is an evaluation function. Storing them
as data would mean either a rules DSL nobody can debug or executable content in
the database. What a tenant owns is the *assignment* — enabled, severity,
enforcement, thresholds, scope — which is the part that genuinely has to differ
between customers without a deploy.

**A tenant with no configuration gets a working baseline.** A row in
`governance_policy_assignments` exists only once something has been changed. No
row means catalog defaults, so the table never grows to policies × tenants and a
new organization is governed on day one.

### The policy catalog

21 policies across five domains:

| Domain | Covers |
|---|---|
| Tagging & Allocation | required keys, controlled values, unallocated-spend ceiling, chargeback coverage |
| Cost Guardrails | budget coverage, budget deliverability, idle waste, commitment coverage, anomaly triage SLA, restricted services |
| Security & Residency | region allow-list, public exposure, encryption at rest, credential rotation, static vs assumed-role credentials, Cloudwise's own hardening |
| Access Governance | privileged-user ceiling, dormant accounts, automation-agent blast radius |
| Operational Assurance | cost-data freshness, cloud connection health |

Each maps to named controls in the FinOps Framework, CIS Benchmarks,
ISO/IEC 27001, SOC 2, NIST CSF 2.0 and GDPR, so a result can be handed over as
evidence rather than as a screenshot.

### Three decisions worth knowing about

**Unknowns are never passes.** A policy that cannot reach a verdict — no ingested
data, an allow-list nobody filled in — returns `inconclusive`. It is excluded
from the score and listed on the dashboard as unanswered. Folding it in as 100%
is the specific failure that makes posture dashboards fiction, and it is the
default behaviour of most tools in this category.

**Findings are keyed by fingerprint, not by run.** `sha256(policyKey|findingKey)`
is stable across sweeps, so a re-run updates a finding instead of duplicating
it. `first_seen_at` therefore survives, which is what makes ageing and a
remediation SLA computable. A finding the sweep does not reproduce is *resolved*
with a timestamp, not deleted.

**Acknowledging and exempting are different things.** Acknowledging records
triage and changes nothing about the score. Exempting suppresses the finding and
costs a written reason (enforced by a database CHECK), an expiry capped at 365
days, a higher permission, and an audit entry. Conflating the two is how every
finding ends up acknowledged and nothing gets fixed.

### Enforcement

`enforcement` is `audit`, `warn` or `block`. `block` is read by
`server/agent/guardrails.ts`: a resource with an open finding under a blocking
policy cannot be the target of an automated agent change until the finding is
fixed or exempted. This is what separates a compliance report from a control.

The governance check runs *after* the existing configuration guardrails and only
for actions that would otherwise touch live infrastructure — a simulation is
still allowed, because blocking one removes the safest way to find out what an
action would do. The lookup fails open and logs, so a database problem cannot
turn the optimization path into an outage.

### Permissions

| Permission | Roles | Covers |
|---|---|---|
| `governance:read` | viewer and above | posture, findings, policies, frameworks |
| `governance:write` | finops and above | change a policy, acknowledge a finding, run a sweep |
| `governance:exempt` | admin and above | grant or revoke an exemption |

Setting the organization's standards and excusing yourself from them are
deliberately different permissions.

### Running it

```bash
npm run db:migrate          # 0019_governance, 0020_login_hardening, 0021_resource_inventory_upsert
npm run dev
```

The scheduler starts automatically (`GOVERNANCE_INTERVAL_HOURS`, default 6;
`GOVERNANCE_ENABLED=false` to disable). "Evaluate now" on the Governance page
triggers a sweep manually, rate-limited to one per minute per tenant.

### Adding a policy

Write the descriptor and `evaluate()` in `catalog.ts`, append to `POLICIES`. The
engine, API, scoring, framework view and UI pick it up with no further changes —
including the parameter form, which is generated from the descriptor.
`catalog.test.ts` asserts the structural invariants every policy must hold, so a
new one is checked without anybody writing a test for it specifically.

Two rules for authors:

- `checked` must be the real denominator. 3 findings out of 3 resources is a
  crisis; 3 out of 3,000 is a Tuesday.
- Return `inconclusive` when you cannot reach a verdict. Never return zero
  findings for an unanswered question.

---

## 2. Platform hardening

| Area | Before | Now |
|---|---|---|
| Security headers | none | CSP, HSTS, nosniff, frame-ancestors, Referrer-Policy, Permissions-Policy, `no-store` on API responses |
| CSRF | none, with `sameSite: 'none'` in production | synchronizer token + Origin check |
| Rate limiting | none | per-account lockout, per-IP sign-in limit, per-user API and expensive-endpoint limits |
| Session fixation | session id survived sign-in | `regenerate()` on every login |
| Brute force | unlimited attempts | 5 attempts → 15 minute lock, in the database |
| Session secret | silent fallback to a placeholder | production refuses to start without a real one |
| Log hygiene | every API response body written to stdout | response keys only |
| Error responses | driver/stack messages returned to the client | status only for 5xx in production |

### Notes on each

**CSRF.** Production issues session cookies with `sameSite: 'none'` so the
console can live on a different origin. That removes the browser's own CSRF
defence, which is why the token is not optional here. The token lives in the
session and is handed to the browser in a readable `XSRF-TOKEN` cookie —
readable on purpose, because same-origin policy is what stops another site from
reading it. The client attaches it by wrapping `window.fetch` once
(`client/src/lib/csrf.ts`) rather than at forty call sites, so it cannot be
forgotten on the next one. Sign-in has no token yet and is covered by the Origin
check; set `ALLOWED_ORIGINS` if the console is on a different host.

**Rate limiting.** In-process counters. The honest limitation: with N replicas
an attacker gets N times the allowance. That is why the per-account lockout is
in the database instead — the two are complementary, not redundant. The limiter
stops one host trying many accounts; the lockout stops many hosts trying one
account, which is what credential stuffing actually looks like. Swap the store
for Redis when a second replica becomes the norm.

**Account lockout is temporary, not permanent.** A permanent lock hands any
anonymous attacker a denial-of-service against a named user, which is a worse
outcome than the guessing it prevents.

**Self-assessment.** `security.platform-hardening` reports all of the above as
governance findings, evaluated from what the running process is actually doing
rather than from what a config file claims. A misconfigured deployment shows up
on the same dashboard as a misconfigured cloud account.

### Known gaps

Stated rather than hidden:

- **No MFA.** The largest remaining gap in authentication. TOTP enrolment, a
  recovery-code path and a per-tenant "require MFA for admin" policy are the
  natural next step; the policy slot for it belongs in the access domain.
- **No SSO.** `@azure/msal-react` is present in the client but unused. Entra ID
  / SAML federation is what most enterprise buyers will ask for before MFA.
- **Login timing.** An unknown username skips bcrypt and so answers faster than
  a wrong password. Closing it means hashing against a dummy digest on every
  miss — worth doing, and worth measuring rather than assuming.
- **Rate limiting is per replica.** See above.
- **Inventory coverage is AWS EC2, EBS and RDS only.** `resource_inventory` had
  never been written to before this change (`storage.createResourceInventory()`
  had no callers), which left the idle-waste, public-exposure and
  encryption-at-rest policies with nothing to read. It is now populated by
  `server/governance/inventory-sync.ts` before each sweep, from the DescribeX
  responses that already carried the security attributes and were discarding
  them — so no new IAM permission is required.

  Not yet covered: **S3** (public-access block and bucket encryption need a
  per-bucket `GetPublicAccessBlock` and `GetEncryptionConfiguration`, which are
  new permissions and N API calls), and **Azure/GCP** (their fetchers do not
  carry encryption or exposure attributes yet). Those resources are excluded
  from the denominator rather than counted as compliant, so the dashboard shows
  what was actually assessed.

- **Utilization is not collected.** The idle policy falls back to the
  provider-reported state — a stopped instance, an unattached volume — rather
  than inventing a CPU figure. Real utilization needs a CloudWatch call per
  resource and belongs with the metrics fetcher, not the inventory sync.
