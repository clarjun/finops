# Cloudwise AWS security model

Written for security reviewers. It states what the system does, and where it
does not yet reach the ideal it is aiming at.

---

## 1. Why not access keys

An access key and secret stored in Cloudwise's database has three properties we
cannot accept:

- **It never expires.** A copy taken today works indefinitely.
- **Revocation is the customer's job.** If our database leaked, every customer
  would have to rotate their own keys before the exposure closed.
- **It cannot be scoped by purpose.** One key does whatever its IAM policy
  allows. A cost query and a "stop this instance" action held the *same*
  credential, so read-only was a property of our code being careful rather than
  of the credential.

Cross-account roles fix all three. Sessions expire within the hour, the customer
holds the revocation lever, and each purpose assumes a different role.

---

## 2. External ID — the confused-deputy defence

Cloudwise assumes roles in many customers' accounts. Without a shared secret,
anyone who learned a customer's role ARN could ask Cloudwise to assume it and
read that customer's data — Cloudwise would be the "confused deputy", using its
own legitimate authority on an attacker's behalf.

The External ID closes that. It is:

- **32 bytes of CSPRNG output** (`randomBytes(32)`, base64url), prefixed
  `cloudwise-`.
- **Not derived from anything.** The generator takes no arguments — structurally
  it cannot encode a tenant id, account id or email. Asserted in
  `server/aws/identity.test.ts`.
- **Per connection**, never shared between customers or between roles of
  different customers.
- **Encrypted at rest** (AES-256-GCM, per-record HKDF derivation) and returned by
  the API exactly once, at creation. No endpoint can read it back.

The trust policy additionally pins `aws:PrincipalArn` to a single Cloudwise role
rather than the account root, and adds an explicit `Deny` for any assume attempt
with no External ID at all.

---

## 3. Tenant isolation

Enforced at four layers:

| Layer | Mechanism |
|---|---|
| API | `routePolicy` middleware; connection writes require `account:write` |
| Data access | `loadAwsConnection()` filters on `organization_id` unconditionally |
| Context | `currentOrgId()` **throws** with no tenant context — it never defaults |
| Session cache | Keyed `organizationId:connectionId:tier` |

A tenant supplying another tenant's connection id gets `null`, not that
tenant's role. Proved in `server/aws/credential-provider.itest.ts` against the
real database, because the isolation *is* the SQL predicate — a mocked test
would only prove the mock.

The session cache key includes the organization deliberately. A cache keyed on
connection id alone would let a bug elsewhere serve one tenant a session minted
for another.

---

## 4. Least privilege and read/write separation

Three tiers, three customer IAM roles:

| Tier | Used by | Capability |
|---|---|---|
| `readonly` | dashboards, ingestion, inventory, recommendations | read cost and resource *metadata* |
| `remediation` | approved optimization actions | stop/start/resize EC2, S3 lifecycle, tagged resources only |
| `deploy` | Terraform deployment agent | create infrastructure (opt-in) |

Both policies were generated from the AWS APIs the code actually calls — 20
distinct commands, enumerated from the source. No `AdministratorAccess`, no
`PowerUserAccess`, no `"Action": "*"`.

`Resource: "*"` appears only where AWS does not support resource-level
restriction for that API (Cost Explorer, `DescribeInstances`,
`GetMetricStatistics`, `tag:GetResources`). Every action that *does* support it is
restricted — remediation is confined to resources tagged
`CloudwiseManaged=true`.

The read-only policy carries an explicit `Deny` on `s3:GetObject`, DynamoDB item
reads, Secrets Manager, SSM parameters and `kms:Decrypt`. **Cloudwise reads the
shape and price of your infrastructure, not its contents.**

---

## 5. Credential lifecycle

1. A caller asks the client factory for a client at a tier.
2. The credential provider loads the tenant's connection, tenant-scoped.
3. It checks the account in the role ARN against the account the connection
   claims, and **refuses before contacting AWS** if they differ.
4. It decrypts the External ID and calls `sts:AssumeRole`.
5. Temporary credentials are cached in memory, keyed by tenant.
6. The SDK receives a *provider function*, not a credential object, so it
   re-invokes near expiry and long operations refresh transparently.

Temporary credentials are **never** written to Postgres, returned by an API,
written to a log, or placed in a model prompt. Only a session count is exposed
for diagnostics.

Errors are translated before they leave the module: raw STS messages can contain
the External ID and full role ARNs.

---

## 6. AI agent boundary

The LLM never holds credentials, and cannot construct arbitrary AWS calls.

```
AI agent → proposes {tool, args}
   → tool registry (schema validation)
   → policy engine (RBAC + risk classification)
   → approval gate (human, for high-risk actions)
   → credential provider (assumes the tier's role)
   → AWS
```

The tool registry deliberately **cannot execute** — it has no public `handler`,
so there is no code path from a model to a cloud API that bypasses
authorization, approval and audit. Tool definitions are exposed to the model as
name, description and argument schema only.

The write-capable session is minted *after* the approval gate, so a credential
that can change infrastructure does not exist until a human has approved the
specific change, and expires within the hour regardless.

---

## 7. Audit

`audit_logs` records actor, tenant, IP, action, outcome, resource and timestamp
for every privileged operation, including denials and approval waivers. It is
append-only and deliberately **outlives tenant deletion** — no cascading foreign
key — so forensic history survives offboarding. That is a deliberate trade-off
against "all data deleted on exit" and is disclosed as such.

Connection lifecycle events recorded: `aws.connection.created`,
`aws.connection.updated`, `aws.connection.validated`,
`aws.connection.validation_failed`, `aws.connection.revoked`.

Audit metadata records *what* was configured, never the External ID.

---

## 8. Known limitations

Stated plainly, because a security model that omits them is not useful.

**Cloudwise still holds one long-lived AWS credential.** `AssumeRole` needs a
caller. Cloudwise runs on Azure Container Apps and has no native AWS identity, so
the bootstrap identity is currently an IAM user whose only permission is
`sts:AssumeRole` on specific role ARNs. This is a large improvement — one
credential we own and rotate, useless without the per-tenant External IDs — but
it is not zero. The intended end state is OIDC federation (Entra managed identity
→ `AssumeRoleWithWebIdentity`), which removes it entirely. The credential
provider is written so that switch requires no connector changes.

**Azure and GCP still use long-lived secrets.** Azure uses a service-principal
client secret; GCP uses a service-account JSON key. Both are the same finding as
AWS access keys. The intended fixes are Azure Lighthouse (delegated resource
management, nothing stored) and GCP Workload Identity Federation. Not yet
implemented.

**No independent certification.** No SOC 2, ISO 27001 or third-party penetration
test currently covers Cloudwise. The controls above are real and verifiable in
source, but they are not externally attested.

**Legacy key-based connections still function.** Deprecated, warned once per
connection in logs, and excluded from the new onboarding flow — but present
until customers migrate.
