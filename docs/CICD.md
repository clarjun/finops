# CI/CD — how it works and how to finish setting it up

Three workflows. CI proves a change is safe to merge; CD promotes one build
through dev, staging and production.

```
Pull request ──▶ CI ──▶ deploy to DEV ──▶ review ──▶ merge ──▶ CD
                 │      (preview URL             │            │
   typecheck ────┤       commented on the PR)    │   staging ─┤
   lint          │                               │   [approval]
   842 tests     │                               │   production
   npm audit     │                               │
   gitleaks      │                               │
   CodeQL        │                               │
```

A pull request is deployed to **dev** so a reviewer can use the change, not just
read it. Staging and production are reached only after merge — a pull request
must never reach production, because then the review would be happening after
the code was already live.

---

## 1. CI — `.github/workflows/ci.yml`

Runs on every pull request and every push to `main`.

| Job | What it does | Blocks merge? |
|---|---|---|
| `quality` | typecheck → lint → **842 tests** → build | yes |
| `security` | `npm audit`, **gitleaks** secret scan | secrets: yes · advisories: no |
| `codeql` | static analysis into the Security tab | yes |
| `ci-passed` | one aggregate status to protect the branch with | — |
| `preview-*` | build → deploy to dev → comment the URL | no |

### Preview deployments

After `ci-passed`, a pull request builds an image tagged `pr-<number>-<sha>`,
deploys it to the shared **dev** environment, and comments the URL on the pull
request. The comment is rewritten on each push rather than appended, so the
review conversation is not buried under near-identical bot messages.

Dev is **shared**: two open pull requests overwrite each other, and whoever
pushed last owns it. The comment always names the commit that is live, so it is
visible when you are looking at someone else'''s change. Per-pull-request preview
environments would remove the collision at the cost of one Container App per
open PR plus teardown logic.

Pull requests **from forks receive no secrets**, so the preview gates itself off
and skips — which is correct, since a fork must not be able to push an image or
touch the subscription. This is also why the workflow uses `pull_request` and
not `pull_request_target`, which would run fork code with write access.

**Protect `CI / ci-passed`, not the individual jobs.** Branch protection names
checks one by one, so adding a job later silently leaves it unenforced. The
aggregate depends on all of them and stays correct as jobs are added.

### Why dependency advisories report rather than block

The tree currently carries **3 critical and 21 high** advisories in production
dependencies. Failing on those would paint CI red on its first run, and a gate
that is always red is one everyone learns to ignore. Counts are published to
each run's summary instead. Once the backlog is down, flip the commented line
in `ci.yml` to make it blocking.

Secret scanning **does** block. A committed credential is a present-tense
incident, not a backlog item — and this repository is public.

### Lint

`npm run lint` · `npm run lint:fix`

The rule set is deliberately small: every rule catches a **defect**, not a style
preference. Errors fail the build (currently zero); warnings do not (currently
121, mostly unused imports). A maximal preset on code written before any linter
existed reports thousands of findings nobody fixes, and the lint step becomes
something people pass with `--no-verify`.

Excluded: `dist/`, `client/src/components/ui/**` (vendored shadcn), and the 26
ad-hoc `*.cjs` debug scripts at the repository root.

---

## 2. CD — `.github/workflows/cd.yml`

Runs on push to `main`, or manually via **Run workflow**.

```
verify      typecheck · lint · tests — so a deploy can never outrun CI
docker      ONE image, tagged with the commit sha, + Trivy scan
dev         migrate → deploy → smoke → rollback on failure
staging     same, only if dev did not fail
production  same, only if staging did not fail, and after approval
```

**One image is promoted, not three builds.** If each environment rebuilt from
source they would be three different artifacts, and testing one would say
nothing about the others.

**Each environment migrates its own database**, because `DATABASE_URL` is an
environment secret. Production's migrations run only after they have already
run against dev and staging.

The smoke test probes **`/api/ready`**, not `/api/health`. Health only proves
node started; a container can serve that happily while every request needing
data fails — exactly the deployment worth rolling back.

### Manual re-deploy

**Actions → CD → Run workflow** takes:

- `image_tag` — a previously built sha, to roll forward or back deliberately
- `only` — `dev`, `staging` or `production` to target one environment

---

## 3. Setup still required

### 3a. Branch protection — do this first

Nothing above is enforced until `main` is protected. Without it, anyone can push
straight past CI.

**Settings → Branches → Add rule** for `main`:

- Require a pull request before merging — **1 approval**
- Require status checks to pass — select **`ci-passed`**
- Require branches to be up to date before merging
- Do not allow force pushes or deletions

### 3b. Environments

**Settings → Environments** — create `dev`, `staging`, `production`.

For each, add these as **environment** secrets (not repository secrets):

| Secret | Why it must be per-environment |
|---|---|
| `CONTAINER_APP_NAME` | **Required.** The deploy refuses without it — see the interlock below |
| `DATABASE_URL` | A separate database per environment |
| `SESSION_SECRET` | A leaked dev secret must not forge production sessions |
| `ENCRYPTION_KEY` | A leaked dev key must not decrypt production credentials |

On **`production`**, add a **Required reviewer**. That is what creates the
approval gate — the workflow declares `environment:`, and GitHub enforces
whatever protection rules exist. Nothing in the YAML can fake it.

> **The interlock.** When an environment does not define a secret, GitHub falls
> back to the repository-level one. For `CONTAINER_APP_NAME` that fallback is
> *production's app* — so a half-configured `dev` would deploy over production
> and report success. Any non-production environment resolving to production's
> app name refuses to deploy, with a red annotation. It **skips** rather than
> failing, so an unconfigured dev does not block the promotion to production.

### 3c. Repository-level secrets

These stay at repository level, shared by all environments:

```
ACR_LOGIN_SERVER      myregistry.azurecr.io
RESOURCE_GROUP        the resource group holding the Container Apps
CONTAINER_APP_NAME    production's app — also used by the interlock
OPENAI_API_KEY
RESEND_API_KEY
```

### 3d. OIDC — removing the long-lived Azure key

Currently authentication uses `AZURE_CREDENTIALS`: a service principal client
secret that grants standing access to the subscription, never expires on its
own, and must be rotated by hand everywhere it is copied.

Federation stores nothing. The runner proves which repository, branch and
environment it is, Entra ID checks that against a federated credential you
defined, and issues a token good for one job.

**The pipeline prefers OIDC and falls back to the secret**, so this can be
adopted without a flag day and rolled back by clearing one secret.

```bash
APP_NAME=cloudwise-github-actions
REPO=clarjun/finops
SUBSCRIPTION=$(az account show --query id -o tsv)

# 1. An app registration for the pipeline
APP_ID=$(az ad app create --display-name "$APP_NAME" --query appId -o tsv)
az ad sp create --id "$APP_ID"

# 2. Trust GitHub — one credential per environment, so a dev run cannot
#    obtain a token scoped to production
for ENV in dev staging production; do
  az ad app federated-credential create --id "$APP_ID" --parameters "{
    \"name\": \"github-$ENV\",
    \"issuer\": \"https://token.actions.githubusercontent.com\",
    \"subject\": \"repo:$REPO:environment:$ENV\",
    \"audiences\": [\"api://AzureADTokenExchange\"]
  }"
done

# 3. Give it only what it needs
az role assignment create --assignee "$APP_ID" --role Contributor \
  --scope "/subscriptions/$SUBSCRIPTION/resourceGroups/<your-resource-group>"
az role assignment create --assignee "$APP_ID" --role AcrPush \
  --scope "/subscriptions/$SUBSCRIPTION/resourceGroups/<rg>/providers/Microsoft.ContainerRegistry/registries/<acr>"
```

Then add as **repository** secrets:

```
AZURE_CLIENT_ID        the APP_ID above
AZURE_TENANT_ID        az account show --query tenantId -o tsv
AZURE_SUBSCRIPTION_ID  az account show --query id -o tsv
ACR_NAME               the registry name, without .azurecr.io
```

The moment `AZURE_CLIENT_ID` exists, both workflows switch to OIDC. Verify a
deployment succeeds, then **delete `AZURE_CREDENTIALS`, `ACR_USERNAME` and
`ACR_PASSWORD`** and disable the ACR admin account.

Under OIDC the Container App is created with a system-assigned identity rather
than stored registry credentials; grant it `AcrPull` on the registry so it can
pull images.

---

## 4. Known gaps

| Gap | Impact |
|---|---|
| Dependency advisories do not block | 3 critical / 21 high unaddressed in production deps |
| No integration tests in CI | `npm run test:integration` exists but needs a database |
| No deployment notifications | Results live in the Actions tab only |
| No DORA metrics | Deployment frequency, lead time, change failure rate, MTTR |
| No canary or blue/green | Container Apps does a rolling replace; rollback is image-swap |
| Infrastructure provisioned inside the deploy | Log Analytics and the Container Apps environment are created on every run; belongs in Terraform |

---

## 5. Local equivalents

```bash
npm run check          # typecheck — same as CI
npm run lint           # lint — same as CI
npm test               # 842 tests — same as CI
npm run build          # production build
npm run db:migrate -- --dry   # what migrations would apply
npm run db:migrate            # apply them
```

Running those four before pushing is the whole of CI, minus the scanners.
