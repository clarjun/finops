# Connecting an AWS account to Cloudwise

Cloudwise connects to your AWS account using a **cross-account IAM role**, not
access keys. You never give Cloudwise a long-lived credential; instead you create
a role in your own account that Cloudwise is permitted to assume, and you can
revoke that permission at any time by deleting the role.

---

## 1. Architecture

```
Cloudwise                      Your AWS account
    │
    │  sts:AssumeRole
    │  + RoleArn
    │  + ExternalId
    ▼
AWS STS  ─────────────────────▶ CloudwiseFinOpsReadOnlyRole
    │                                    │
    │  temporary credentials             │  read-only policy
    │  (expire within the hour)          ▼
    ▼                              Cost Explorer, EC2, RDS,
AWS API calls                      S3 metadata, CloudWatch, tags
```

Three properties follow from this:

- **Nothing long-lived is stored.** Cloudwise holds a role ARN and an External
  ID. Neither can be used by anyone who does not also control the Cloudwise AWS
  principal named in your trust policy.
- **Credentials expire.** Every session is short-lived and refreshed
  automatically. There is no key to rotate and nothing to leak permanently.
- **You hold the revocation lever.** Delete the role, or remove the trust
  statement, and Cloudwise loses access immediately — no coordination required.

---

## 2. Onboarding, step by step

### Step 1 — Register the account in Cloudwise

Configuration → Cloud Accounts → **Connect AWS Account**. Enter your 12-digit AWS
account ID and a display name.

Cloudwise generates an **External ID** and shows it once. Copy it now — it cannot
be retrieved again through any API or screen. If you lose it, revoke the
connection and create a new one.

### Step 2 — Create the read-only role

In your AWS account, create an IAM role named `CloudwiseFinOpsReadOnlyRole`
(the name is yours to choose; only the ARN matters).

**Trust policy** — from `docs/aws-iam-policies/cloudwise-trust-policy.json`,
substituting the two placeholders:

| Placeholder | Value |
|---|---|
| `<CLOUDWISE_AWS_PRINCIPAL_ARN>` | Shown in the Cloudwise connection screen |
| `<EXTERNAL_ID>` | The External ID from Step 1 |

**Permissions policy** — attach
`docs/aws-iam-policies/cloudwise-finops-readonly-policy.json`.

### Step 3 — Give Cloudwise the role ARN

Paste the role ARN, e.g.
`arn:aws:iam::123456789012:role/CloudwiseFinOpsReadOnlyRole`.

Cloudwise checks that the account inside the ARN matches the account you
registered, and refuses if it does not.

### Step 4 — Validate

Click **Validate Connection**. Cloudwise will:

1. Validate the ARN format.
2. Call `sts:AssumeRole` with the External ID.
3. Call `sts:GetCallerIdentity` with the resulting credentials.
4. Confirm the account it actually reached is the account you registered.
5. Activate the connection.

The connection stays **inactive until validation succeeds**, so a half-configured
account is never picked up by scheduled ingestion.

### Step 5 (optional) — Enable remediation

Read-only is the default and the recommended starting posture. To let Cloudwise
act on approved recommendations, create a second role with
`cloudwise-finops-remediation-policy.json` — the same trust policy — and add its
ARN as the **remediation role**.

Without a remediation role the connection is read-only and remediation attempts
fail with a clear message rather than an opaque AWS denial.

---

## 3. What each role can do

**Read-only** — Cost Explorer, budgets, EC2/RDS/Lambda/EBS inventory, S3 and log
group *metadata*, CloudWatch metrics, resource tags.

It explicitly **cannot read your data**. The policy grants
`s3:ListAllMyBuckets` and `s3:GetBucketLocation` but not `s3:GetObject`, and
contains an explicit `Deny` on object reads, DynamoDB item reads, Secrets
Manager, SSM parameters and `kms:Decrypt`.

**Remediation** — stop, start and resize EC2 instances; set S3 lifecycle
configuration. Nothing else, and only on resources tagged
`CloudwiseManaged=true`. It carries an explicit `Deny` on every destructive
action (`TerminateInstances`, `DeleteVolume`, `DeleteDBInstance`, `DeleteBucket`)
and on `iam:*`, `sts:AssumeRole` and `organizations:*`, which closes the
privilege-escalation paths.

---

## 4. Troubleshooting

| Message | Cause | Fix |
|---|---|---|
| *Could not assume the … IAM role* | Trust policy does not name the Cloudwise principal, **or** the External ID does not match | Re-check both. AWS returns the same `AccessDenied` for either, so verify both. |
| *The … role does not exist in that AWS account* | Role deleted or renamed | Recreate it, or update the ARN in Cloudwise |
| *The role belongs to AWS account X, but this connection is registered for Y* | ARN from the wrong account | Use the ARN from the registered account |
| *has no remediation role configured* | Read-only connection, remediation attempted | Add a remediation role (Step 5) |
| *AWS is rate-limiting credential requests* | STS throttling | Transient; retries automatically |
| *Cloudwise's AWS identity was rejected by STS* | Cloudwise-side misconfiguration, not yours | Contact Cloudwise support |

---

## 5. Revoking access

Configuration → the connection → **Revoke**. Cloudwise stops assuming the role
immediately and drops any cached session.

**Also delete the IAM roles in your AWS account.** Revoking in Cloudwise stops us
using the trust relationship; deleting the roles removes it. Until you do, a
trust statement naming Cloudwise remains in your account.

Cost history already collected is retained, and the audit record of what the
connection did is retained deliberately — see `aws-security-model.md`.

---

## 6. Migrating from access keys

Existing key-based connections keep working; the authentication method is
recorded per connection. To migrate:

1. Create the role and validate it as above.
2. Confirm cost data continues to appear.
3. **Delete the IAM user and its access keys in AWS.**

Step 3 is the one that delivers the security benefit. Until the keys are deleted
they remain valid regardless of what Cloudwise does.
