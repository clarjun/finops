# CloudWise — System Architecture

**Multi-cloud FinOps, governance and infrastructure automation platform**

_Version as of 2026-09-24 · 46 tables · 93 API endpoints · 819 tests_

---

## 1. What this product is

CloudWise answers four questions about a multi-cloud estate, and the architecture
is organised around the fact that they are **four different questions with four
different data paths**:

| Question | Menu | Source of truth |
|---|---|---|
| What did we spend? | Dashboard, Reports, Forecast, Budgets | `cost_facts` — ingested billing |
| Where is money wasted? | Optimization, AI Query, AI Economics | `cost_facts` + live provider APIs |
| Are we configured safely? | Governance | `resource_inventory` + live APIs |
| How do we change things? | Deploy Agent, Deployments, Deploy Library | Terraform + Git |

The single most important architectural decision is that **cost and configuration
are read on different paths**. Cost comes from billing exports, which are
authoritative, complete, and up to 48 hours stale. Configuration comes from live
provider APIs, which are current but rate-limited and partial. Conflating them
produces a dashboard that is confidently wrong — see §4.

---

## 2. Stack

```
┌─────────────────────────────────────────────────────────────────────┐
│  Browser                                                            │
│  React 18 · Vite 5 · TanStack Query 5 · wouter · Tailwind + shadcn  │
│  Recharts · MSAL (Entra SSO)                                        │
└────────────────────────────┬────────────────────────────────────────┘
                             │  HTTPS · session cookie + CSRF token
┌────────────────────────────▼────────────────────────────────────────┐
│  Express 4 (Node, TypeScript, ESM)                                  │
│                                                                     │
│   security headers → rate limit → session → CSRF → auth guard       │
│        → route policy (deny-by-default) → audit → handler           │
│                                                                     │
│   AsyncLocalStorage carries { organizationId, userId } per request  │
└────────────────────────────┬────────────────────────────────────────┘
                             │  Drizzle ORM · node-postgres pool
┌────────────────────────────▼────────────────────────────────────────┐
│  PostgreSQL (Azure Database for PostgreSQL)                         │
│  46 tables · every tenant-scoped row carries organization_id        │
└─────────────────────────────────────────────────────────────────────┘

External: AWS (11 SDK clients) · Azure (6) · GCP (4) · OpenAI · GitHub · LiteLLM
```

**Why wouter, not React Router** — the app is ~20 pages with no nested routing;
wouter is 2KB against 20KB.

**Why Drizzle, not Prisma** — the schema is shared verbatim between server and
browser (`shared/schema.ts`), and several hot paths need raw SQL (expression-index
upserts, `to_char` day bucketing) without leaving the type system.

---

## 3. Request lifecycle

Every `/api` request passes through the same chain. The order matters and is
deliberate:

```
1. security-headers      CSP, HSTS, X-Frame-Options
2. rate-limit            in-process, per IP; login gets a tighter bucket
3. session               PostgreSQL-backed; regenerated on login
4. csrf                  synchroniser token + Origin check on mutations
5. auth-guard            401 if no session (except /health, /auth/*, 2 GitHub callbacks)
6. route-policy          DENY BY DEFAULT — see below
7. audit                 records actor, action, outcome, status
8. handler               inside runAsSystem/tenant context
```

### 3.1 Deny-by-default authorization

`server/middleware/route-policy.ts` holds a table mapping `(method, path-regex)`
to a required permission. **A route with no entry is refused**, logged, and
audited:

```ts
if (!rule) {
  console.error(`[RoutePolicy] No policy for ${req.method} ${req.path} — denying.`);
  // → 403 + audit 'authz.no_policy'
}
```

This is the opposite of the usual "add a guard to each route" pattern, and it is
chosen because the failure modes are asymmetric: forgetting a guard on an
allow-by-default system silently exposes data, whereas forgetting an entry here
produces an immediate, loud 403 in development.

### 3.2 Multi-tenancy

Tenancy is **ambient**, not passed as a parameter:

```ts
// server/tenant-context.ts
const store = new AsyncLocalStorage<{ organizationId: number; userId?: number }>();
export const currentOrgId = () => { /* throws if absent */ };
export function runAsSystem<T>(organizationId: number, fn: () => T): T;
```

`currentOrgId()` **throws** outside a context rather than defaulting. A default
would mean a background job silently reading tenant 1's data. Schedulers and
callbacks wrap their work in `runAsSystem(orgId, …)` explicitly.

### 3.3 RBAC

Five roles, 16 permissions, strictly nested:

```
viewer   → cost:read, governance:read, audit-free
engineer → + export:read, agent:propose
finops   → + budget:write, report:write, agent:approve, governance:write
admin    → + governance:exempt, account:write, agent:execute,
             agent:configure, user:manage, audit:read
owner    → + org:manage
```

One deliberate split: `governance:write` (set the standard) is a FinOps job;
`governance:exempt` (accept a breach of it) is an admin job. Letting the same
person do both removes the control.

---

## 4. Data architecture — the two paths

This is the part most worth understanding.

```
         ┌──────────────── PATH A: COST (authoritative, stale) ─────────────┐
         │                                                                  │
AWS Cost Explorer ─┐                                                        │
Azure Cost Mgmt  ──┼─→ cloud/adapters/* ─→ ingestion/ingest.ts ─→ cost_facts│
GCP BigQuery     ──┘        (normalise)         (idempotent)       (FOCUS)  │
                                                                     │      │
                                            ┌────────────────────────┼──────┘
                                            ▼                        ▼
                                    Dashboard, Reports        Forecast, Budgets
                                    Optimization, AI Query    Governance (cost policies)

         ┌──────────── PATH B: CONFIGURATION (current, partial) ────────────┐
         │                                                                  │
AWS EC2/RDS/S3/EBS ─┐                                                       │
Azure ARM          ─┼─→ *-resource-inventory.ts ─→ resource_inventory       │
GCP Compute        ─┘        (18 regions)              │                    │
                                                        ▼                   │
                                           Governance (security policies)   │
                                           Optimization (waste detection)   │
                                                                            │
         ┌────────────── PATH C: AI METERING (per-token) ──────────────────┐
         │                                                                 │
CloudWatch AWS/Bedrock ─┐                                                  │
Azure Monitor          ─┼─→ ai-economics/adapters/* ─→ ai_usage_records     │
(OpenAI/Vertex/Anthropic: not built)          │              │             │
                                               ▼              ▼            │
                                        LiteLLM catalog   ai_spend_records  │
                                        (4,300 models)    (priced)          │
```

### 4.1 `cost_facts` — the FOCUS fact store

The cost table implements the **FinOps FOCUS 1.x** specification, which is why
its columns read like a standard rather than like AWS:

```
billing_account_id / sub_account_id     charge_period_start / end
service_name / service_category         billed_cost / effective_cost / list_cost
charge_category / charge_description    pricing_quantity / pricing_unit
resource_id / region_id                 commitment_discount_id
tags (jsonb)                            source_hash, ingestion_run_id
```

Three consequences:

- **`effective_cost` is the default**, not `billed_cost`. Effective cost has
  commitments amortised and credits applied. Forecasting on billed cost models a
  reservation purchase as recurring spend.
- **`charge_category <> 'Tax'` is filtered everywhere.** Tax is not attributable
  to a service and would distort both per-service reporting and forecasts.
- **`source_hash` makes ingestion idempotent.** Re-running a window updates rather
  than duplicates.

### 4.2 Why day bucketing uses `to_char`, not timestamps

`ingestion/cost-records.ts` groups by `to_char(charge_period_start, 'YYYY-MM-DD')`.
Any module that compares raw timestamps instead will disagree with the reports by
a timezone offset. This caused a **$391 discrepancy** between the Reports page and
the AI Economics coverage view until both were aligned — every service short by a
few percent, which reads as a pricing bug rather than a calendar one.

**Rule: any new module reading `cost_facts` by day must use the same expression.**

### 4.3 Region coverage

`resource_inventory` is populated across **every enabled region**, discovered via
`DescribeRegions` and scanned six at a time. This was single-region (`us-east-1`)
until recently, which meant governance described one region while presenting
itself as the state of the account — 12 EBS volumes, 10 EC2 instances and an
internet-exposed RDS instance were invisible.

---

## 5. Menu-by-menu architecture

### 5.1 Dashboard `/`

Reads **the fact store, not the live clients** — `GET /api/costs/processed`.
Two separate cost paths exist in this codebase and this is the fast one: indexed
queries against `cost_facts` rather than provider API calls.

```
dashboard.tsx → /api/costs/processed → ingestion/processed-view.ts → cost_facts
```

### 5.2 Reports `/reports`

Streamed over **Server-Sent Events** in 11 stages, because a full FinOps report
was a 40-second request that looked like a hang:

```
1 load data        → fetchCostRecords (facts, live fallback)
2 spend overview   5 expensive resources   8 optimization opportunities
3 top drivers      6 cost trend            9 department allocation
4 …                7 anomalies            10 AI spend analysis
                                          11 cache
```

Each section streams as it completes and **failures are recorded per section** —
a transient AWS failure once produced a cached report showing no AI spend for a
whole day, so a report is only served from cache if the sections it needs succeeded.

Sub-modules: `reports/{ai-cost-analyzer, anomaly-detector, cost-trend-analyzer,
waste-detector, optimization-calculator, department-allocator, expensive-resources-fetcher}`.

### 5.3 AI Query `/ai-query`

Natural language over cost data. `analysis/ai-prompt-builder.ts` assembles a
bounded context from `cost_facts`; `openai-client.ts` calls the model. The prompt
carries **aggregates, never raw rows** — a full estate would exceed the context
window and leak resource identifiers into a third-party service.

### 5.4 AI Economics `/ai-economics`

Three tabs, three distinct concerns:

| Tab | Source | Answers |
|---|---|---|
| Tokens & calls | `ai_usage_records` + `ai_spend_records` | metered usage, priced |
| Billed spend | `cost_facts` | what the invoice says |
| **Coverage** | both, reconciled | *what fraction of AI spend we can see tokens for* |

Five tables: `ai_providers`, `ai_models`, `ai_model_pricing` (effective-dated),
`ai_usage_records`, `ai_spend_records`.

**Pricing resolution order:** tenant override → catalog → latest `effective_from`.
Rates are never overwritten; a change closes the previous row the day before the
new one starts, so historical figures stay as reported.

**Why LiteLLM over the AWS Price List:** a scan of 80 pages of the Price List
across every region returned **zero rows for Claude 4.x** — the models actually in
use. LiteLLM's catalog has all 4,300, keyed by the exact runtime model id.
Critically, routing prefixes are kept verbatim: `us.anthropic.claude-sonnet-4-6`
costs **10% more** than `anthropic.claude-sonnet-4-6`, so normalising them away
would under-price every cross-region call invisibly.

**The structural limit:** AWS bills Bedrock as two unrelated products —
`Amazon Bedrock` (the inference API, emits CloudWatch metrics, meterable) and
`Claude X (Amazon Bedrock Edition)` (Marketplace subscriptions, **no telemetry
exists**). On a representative tenant that is $28 against $12,944. The Coverage
tab exists so this gap is stated rather than implied.

### 5.5 Cost Estimator `/cost-estimator`

`cost-estimator/` — takes a described workload, resolves **live AWS Price List
rates**, returns a monthly estimate. Not a lookup table: prices are fetched per
SKU so an estimate can be defended.

### 5.6 Forecast `/forecast`

Reads 90 days from `cost_facts` (one indexed query, formerly 90 days of provider
API calls) and projects forward. Uses `effective_cost` for the reason in §4.1.

### 5.7 Budgets `/budgets` · Alerts

`budgets`, `alert_rules`, `anomaly_events`. A scheduler evaluates thresholds and
dispatches via `email-service.ts`.

### 5.8 Optimization `/optimization`

```
analysis/full-analysis-engine.ts
  ├─ savings-engine.ts          commitment coverage, rightsizing
  ├─ attribution-engine.ts      whose cost is this
  ├─ aws|azure-cost-deep-dive   per-service breakdown
  ├─ aws|azure-tagging-service  allocation quality
  └─ service-analyzer-router    dispatch per service
        → optimization_recommendations → optimization_plans → optimization_actions
                                                                    │
                                                          savings_measurements
                                                          (did it actually save?)
```

The last step matters: recommendations without measured outcomes are a wish list.

### 5.9 Governance `/governance`

Five tabs over one engine.

```
governance/
  catalog.ts       21 policies across 5 domains
  data.ts          loads the dataset — SERIALISED, not Promise.all (see below)
  engine.ts        evaluate → fingerprint → upsert → reconcile
  scoring.ts       severity-weighted, unknowns excluded
  scheduler.ts     nightly sweep
```

**Scoring**, in three properties that each rule out the obvious simpler formula:

1. *Severity dominates count* — critical weighs 10, info weighs 0. "47 violations"
   is not worse than one unencrypted production database.
2. *The denominator is real* — scoring is on violation **rate**, so a large estate
   does not score worse than a small careless one.
3. **Unknowns are not passes** — a policy that could not run is excluded from the
   score and reported separately. Counting it as 100% would let a broken pipeline
   read as perfect compliance.

**Per-policy score impact** (`policy_impacts` on each run) answers "what do I fix
first", which a finding count cannot: 14 failures of 20 examined is a 70% failure
rate; the same 14 of 3,000 is a rounding error. Both render as "14 findings".
Gains are exact and additive — `100 · w · gap / Σw` — so the UI can honestly say
"fix these three and you reach 80".

**Findings are fingerprinted** (`sha256(policyKey|findingKey)`) and upserted, so
re-running never duplicates and `first_seen_at` survives — which is what ageing
and SLA are computed from. Reconciliation is by `last_run_id <> runId`, not
`NOT IN (fingerprints)`, which does not scale.

**Frameworks tab** maps policies to CIS / ISO 27001 / SOC 2 / NIST CSF 2.0 / GDPR /
FinOps Framework. A control nobody monitors shows as **unmonitored, never as
passing**. Honest coverage is thin by nature — 9 of ISO 27001's 93 Annex A
controls — because the other 84 are about people and process, which no cloud tool
can evidence.

> **Known deadlock, worth not reintroducing:** `data.ts` loads its dataset
> serially. Firing 10 concurrent queries plus an advisory-lock connection against
> `PGPOOL_MAX=10` exhausted the pool and hung the sweep.

### 5.10 Deploy Agent `/infra-agent` · Deployments · Deploy Library

The largest module (35 files). Natural language → Terraform → review → apply.

```
clarify.ts     ask what is ambiguous before generating anything
   ↓
compiler.ts    → infra_plans / infra_plan_nodes (a DAG)
   ↓
terraform/generator.ts → HCL
terraform/plan-risk.ts → 7 rules: public exposure, encryption, open ingress,
                          public storage, data protection, IAM breadth,
                          stateful replacement
   ↓
┌── GitOps path ─────────────┐   ┌── Direct path ──────────────┐
│ git/deliver.ts             │   │ engine.ts → worker.ts       │
│ blobs → tree → commit      │   │ infra_runs / infra_run_nodes │
│ → ref → PR  (atomic)       │   │ infra_approvals (gates)      │
│ Human merges; THEIR        │   │ failure.ts → remedies.ts     │
│ pipeline applies           │   │ teardown.ts + teardown-safety│
└────────────────────────────┘   └──────────────────────────────┘
```

**Terraform state** (`infra_state_backends`) supports S3 / azurerm / gcs / local
and **refuses a backend without a lock table** — concurrent applies against
unlocked state corrupt it.

**Guardrails** (`agent/guardrails.ts`) consult `blockingViolationsFor(resourceId)`
— a governance policy set to `block` stops the *agent* from changing a resource
already in violation. It never modifies or deletes anything in the cloud itself.

**Agent safety posture**, enforced by the `access.agent-blast-radius` policy:
`auto_execute_enabled`, `dry_run_mode`, `safety_mode`,
`max_cost_impact_without_approval`. The policy watches the *combination*, because
nobody grants an agent unsupervised delete rights on purpose — they arrive one
convenient setting at a time.

### 5.11 GitHub integration

Registered **from inside the product** via GitHub's App Manifest flow. No `.pem`
download, no environment variable, nothing pasted:

```
① POST manifest → github.com/settings/apps/new    (operator clicks Create)
② GitHub → /api/infra/git/app/setup?code=&state=  (HMAC-signed, 10-min state)
③ POST /app-manifests/{code}/conversions          → id + pem + webhook_secret
④ encrypted into github_app_credentials, PER ORGANIZATION
⑤ customer installs on their repos → /installation/repositories → dropdown
```

**Credential chain:** private key → JWT (≤10 min, RS256) → installation token
(1 hour, scoped to one repository) → Git Data API.

**No environment fallback, deliberately.** A shared `GITHUB_APP_PRIVATE_KEY` would
mean one customer's pull requests were opened by an App another customer
registered, and a missing registration would be papered over instead of reported.

**Why per-organization** rather than GitHub's one-App-per-product model: a shared
row in a multi-tenant deployment lets one customer's admin replace the App
everyone else authenticates through. Registration is three clicks, so isolation
is free.

The two GitHub callbacks are the only auth-exempt `/api` routes besides
`/health` and `/auth/*`. They are not unauthenticated — the organization arrives
in an HMAC-signed state verified in constant time before anything is written.

### 5.12 AI Agent `/agent`

`ai-agent-planner.ts` → `ai-action-executor.ts` → `ai-self-correction.ts`, with
`action_feedback` closing the loop. Config in `agent_config`.

### 5.13 Configuration `/configuration`

Cloud account CRUD per provider, the ingestion panel, and GitHub setup.
Credentials are AES-encrypted (`encryption.ts`) in `cloud_accounts`;
`rotate-key.ts` handles `ENCRYPTION_KEY` rotation.

### 5.14 User Management · Audit Log

`users` with role assignment; `audit_logs` records actor, action, resource,
outcome and status for every mutating request plus every authorization denial.

---

## 6. Cross-cutting concerns

### 6.1 Provider abstraction

```
cloud/registry.ts       provider → adapter
cloud/adapters/{aws,azure,gcp}.ts
cloud/query-runner.ts   one place every provider call passes through
cloud/rate-budget.ts    per-provider call budget
cloud/failure.ts        typed failures, never silent empties
cloud/fetch-runtime.ts  retry, accounting
```

Every provider call goes through `runProviderQuery(provider, label, fn)`, which
is what makes API-call counts and rate budgets possible at all.

**A failure is never an empty result.** `cloud/failure.ts` exists because
"returned nothing" and "could not ask" look identical to a dashboard and mean
opposite things.

### 6.2 Scheduling

Three in-process schedulers, each independently disableable:

```
ingestion/scheduler.ts    cost ingestion       INGESTION_ENABLED
reports/scheduler.ts      scheduled reports
governance/scheduler.ts   nightly sweep        GOVERNANCE_ENABLED
```

Advisory locks prevent two instances running the same sweep.

### 6.3 Error surfacing

`client/src/lib/api.ts` is the single client-side entry point. It reads
`{error}`, `{message}`, `{detail}`, `{success:false,error}` and falls back per
status (401 → "your session has expired"). A status check happens **before**
`res.json()` — the reverse order silently swallowed every error body.

### 6.4 Encryption

AES via `encryption.ts` with `ENCRYPTION_KEY`. Encrypted at rest: cloud
credentials, GitHub tokens, GitHub App private keys, webhook secrets.

---

## 7. Known gaps

Stated plainly, because an architecture document that only lists what works is a
sales deck.

| Gap | Impact |
|---|---|
| **Azure SP has no ARM role** — every Resource Manager call 403s | Azure resource inventory, rightsizing and AI metering are all blind. Cost works (billing scope is separate). |
| **AI adapters missing** — OpenAI, Vertex, Anthropic declared but not built | ~99.8% of AI spend on a Marketplace-billed tenant has no token data |
| **No connection validation for Azure/GCP** | `ops.connection-health` reports a finding whose remediation does not exist. Only AWS has a validate endpoint. |
| **No compliance evidence export** | An auditor asking for Q3 ISO evidence cannot be served without screenshots |
| **Framework denominators mislead** | "ISO 27001: 4 compliant" of 9 mapped reads as 4 of 9, not 4 of 93 |
| **`server/routes.ts` is 2,968 lines** | Newer modules own their routes; this file has not been split |
| **Single-process schedulers** | Advisory locks make it safe, but there is no distributed queue |
| **2.4 MB JS bundle** | No code splitting |

---

## 8. Principles this codebase holds to

These are visible in the code and worth preserving:

1. **A gap is reported, never implied.** Not-assessed policies, unmonitored
   controls, unmetered AI spend and unpriced models are all surfaced with the
   reason. A green tick over a check that did not run is the failure mode that
   makes a posture dashboard fiction.
2. **Deny by default.** Unlisted route, missing tenant context, unproved
   connection — all refuse rather than assume.
3. **History is never rewritten.** Effective-dated pricing, fingerprinted
   findings that keep `first_seen_at`, revoked-not-deleted exemptions.
4. **Idempotence is designed in.** `source_hash` on cost facts, fingerprints on
   findings, hour-aligned AI usage buckets — all upsert rather than append.
5. **Failure is distinguishable from absence**, everywhere.
6. **Nothing touches the cloud without a human**, except the optimization agent,
   which is itself bounded by a governance policy and currently in dry-run.
