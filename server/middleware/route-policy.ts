/**
 * Which permission each API route requires.
 *
 * Kept as one table rather than a requirePermission() call on each of the ~70
 * handlers, for two reasons:
 *
 *   1. A security reviewer can read the entire authorization surface in one
 *      screen instead of grepping routes.ts.
 *   2. It fails closed. A route with no matching rule is denied, so adding an
 *      endpoint without thinking about authorization produces an immediate 403
 *      in development rather than an open endpoint in production. That is the
 *      inverse of the bug this codebase already had, where `requireAuth` existed
 *      but was applied to nothing.
 *
 * Rules are evaluated top to bottom; the first match wins, so specific paths
 * must precede the prefixes that would also match them.
 */
import type { Express, Request, Response, NextFunction } from "express";
import { normalizeRole, roleHasPermission, type Permission } from "../rbac";
import { recordAudit } from "../audit";

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface Rule {
  /** '*' matches any method. */
  methods: Method[] | '*';
  pattern: RegExp;
  permission: Permission;
}

const R = (methods: Method[] | '*', pattern: RegExp, permission: Permission): Rule =>
  ({ methods, pattern, permission });

const RULES: Rule[] = [
  // ── Agent: propose / approve / execute are deliberately separate ───────────
  // Executing mutates live cloud infrastructure. Whoever proposes an action
  // must not be the same person who executes it.
  R(['POST'], /^\/api\/agent\/actions\/\d+\/execute$/,        'agent:execute'),
  R(['POST'], /^\/api\/agent\/actions\/\d+\/rollback$/,       'agent:execute'),
  R(['POST'], /^\/api\/agent\/actions\/\d+\/retry$/,          'agent:execute'),
  R(['POST'], /^\/api\/agent\/plans\/\d+\/execute$/,          'agent:execute'),
  R(['POST'], /^\/api\/agent\/auto-correct$/,                 'agent:execute'),
  R(['POST'], /^\/api\/agent\/actions\/\d+\/approve$/,        'agent:approve'),
  R(['POST'], /^\/api\/agent\/actions\/\d+\/reject$/,         'agent:approve'),
  R(['POST'], /^\/api\/agent\/actions\/\d+\/analyze-failure$/,'agent:propose'),
  R(['GET'],  /^\/api\/agent\/config$/,                       'cost:read'),
  R(['PUT', 'PATCH'], /^\/api\/agent\/config$/,               'agent:configure'),
  R(['GET'],  /^\/api\/agent\/plans/,                         'cost:read'),
  R(['GET'],  /^\/api\/agent\/actions/,                       'cost:read'),
  R(['POST'], /^\/api\/agent\/plan$/,                         'agent:propose'),
  R(['PATCH', 'DELETE'], /^\/api\/agent\/plans/,              'agent:propose'),
  R(['DELETE'], /^\/api\/agent\/actions\/\d+$/,               'agent:propose'),

  // ── Cloud accounts: credentials ───────────────────────────────────────────
  R(['GET'],  /^\/api\/cloud-accounts/,                       'account:read'),
  R(['POST', 'PATCH', 'PUT', 'DELETE'], /^\/api\/cloud-accounts/, 'account:write'),
  R(['GET'],  /^\/api\/azure\/config$/,                       'account:read'),
  R(['POST'], /^\/api\/azure\/config$/,                       'account:write'),
  R(['POST'], /^\/api\/azure\/test$/,                         'account:write'),
  R(['POST'], /^\/api\/azure\/refresh$/,                      'account:read'),

  // ── Budgets and alerting ──────────────────────────────────────────────────
  R(['GET'],  /^\/api\/budgets/,                              'cost:read'),
  R(['POST', 'PATCH', 'PUT', 'DELETE'], /^\/api\/budgets/,    'budget:write'),
  R(['GET'],  /^\/api\/alerts\/rules/,                        'cost:read'),
  R(['POST', 'PATCH', 'PUT', 'DELETE'], /^\/api\/alerts\/rules/, 'budget:write'),

  // ── Reports ───────────────────────────────────────────────────────────────
  R(['GET'],  /^\/api\/reports\/schedules/,                   'cost:read'),
  R(['POST', 'PATCH', 'PUT', 'DELETE'], /^\/api\/reports\/schedules/, 'report:write'),
  R(['GET'],  /^\/api\/reports\//,                            'cost:read'),
  R(['GET'],  /^\/api\/export\//,                             'export:read'),

  // ── Optimization ──────────────────────────────────────────────────────────
  R(['POST'], /^\/api\/optimization\/recommendations\/generate$/, 'agent:propose'),
  R(['PATCH'],/^\/api\/optimization\/recommendations/,        'agent:approve'),
  R(['GET'],  /^\/api\/optimization\//,                       'cost:read'),

  // ── Infrastructure Deployment Agent ───────────────────────────────────────
  // Starting a LIVE run creates real cloud infrastructure and costs real money,
  // so it needs the same permission as executing an agent action. Compiling a
  // plan and simulating are proposals and stop at agent:propose.
  R(['POST'], /^\/api\/infra\/plans\/\d+\/runs$/,             'agent:execute'),
  R(['POST'], /^\/api\/infra\/runs\/\d+\/advance$/,           'agent:execute'),
  // Destroying infrastructure is at least as consequential as creating it, so
  // it needs the same permission. The teardown then stops for an approval of
  // its own, which is a separate permission again.
  R(['POST'], /^\/api\/infra\/runs\/\d+\/teardown$/,          'agent:execute'),
  R(['POST'], /^\/api\/infra\/approvals\/[^/]+\/decide$/,     'agent:approve'),
  // GitOps delivery. Raising a pull request creates NO infrastructure - it
  // writes a proposal into a repository, and the customer's own review and
  // pipeline decide whether it ever runs. So it is a proposal, not an
  // execution, and deliberately does not need agent:execute.
  R(['POST'], /^\/api\/infra\/plans\/\d+\/pull-request$/,      'agent:propose'),
  R(['GET'],  /^\/api\/infra\/plans\/\d+\/pull-requests$/,     'cost:read'),
  R(['GET'],  /^\/api\/infra\/pull-requests$/,                 'cost:read'),
  // Storing a repository access token is a credential change: a token that can
  // open a pull request can usually read every repository its owner can.
  R(['PUT', 'DELETE'], /^\/api\/infra\/git-connection$/,        'account:write'),
  R(['GET'],  /^\/api\/infra\/git-connection$/,                 'account:read'),
  // Connecting through the GitHub App binds this tenant to an installation
  // that can write to a repository, so it sits with the token path rather than
  // being waved through for having no secret in the request body.
  R(['POST'], /^\/api\/infra\/git-connection\/app$/,            'account:write'),
  R(['GET'],  /^\/api\/infra\/git-connection\/app$/,            'account:read'),
  // Registering a GitHub App creates a credential this tenant will open pull
  // requests with, so it sits with account administration. The two callbacks
  // GitHub redirects to are in EXEMPT below and verify a signed state instead.
  R(['POST'],   /^\/api\/infra\/git\/app\/manifest$/,            'account:write'),
  // Renders the self-submitting manifest form. A GET, but it starts a
  // credential change, so it carries the same permission as the POST.
  R(['GET'],    /^\/api\/infra\/git\/app\/register$/,            'account:write'),
  // Accepts a hand-created App's id and private key. Same credential
  // change as the manifest flow, so the same permission.
  R(['POST'],   /^\/api\/infra\/git\/app\/manual$/,              'account:write'),
  R(['DELETE'], /^\/api\/infra\/git\/app$/,                     'account:write'),
  R(['GET'],    /^\/api\/infra\/git\/app$/,                     'account:read'),
  R(['GET'],    /^\/api\/infra\/git\/repositories$/,            'account:read'),
  // Where Terraform state lives decides whether infrastructure stays
  // trackable at all, so changing it sits with account administration.
  R(['PUT'],  /^\/api\/infra\/state-backend$/,                  'account:write'),
  R(['GET'],  /^\/api\/infra\/state-backend$/,                  'account:read'),
  R(['POST'], /^\/api\/infra\/plans\/\d+\/compile$/,          'agent:propose'),
  // Saving a blueprint and cloning one are proposals: they create plans, never
  // infrastructure.
  R(['POST'], /^\/api\/infra\/runs\/\d+\/save-as-template$/,  'agent:propose'),
  R(['POST'], /^\/api\/infra\/templates\/\d+\/instantiate$/,  'agent:propose'),
  // Reading public provider documentation and citing it against a step creates
  // no infrastructure and spends nothing; it is a knowledge action.
  R(['POST'], /^\/api\/infra\/steps\/research$/,              'agent:propose'),
  R(['POST'], /^\/api\/infra\/plans$/,                        'agent:propose'),
  R(['GET'],  /^\/api\/infra\/accounts$/,                     'account:read'),
  R(['GET'],  /^\/api\/infra\//,                              'cost:read'),

  // ── AWS cross-account connections ─────────────────────────────────────────
  // findRule() takes the FIRST match, so the specific validate rule must
  // precede the general POST rule or it would never be reached.
  //
  // Validation performs a real AssumeRole, so it is not a free read — but it
  // creates nothing, returns no credentials, and an operator needs to diagnose
  // a broken connection without holding write permission.
  // Reports how Cloudwise itself authenticates to AWS, and the IAM values an
  // operator must configure. Claims only — no token, no credential.
  R(['GET'],  /^\/api\/aws\/federation$/,                     'account:read'),
  R(['POST'], /^\/api\/aws\/connections\/\d+\/validate$/,      'account:read'),
  // Connecting, re-pointing or revoking an account is the most consequential
  // configuration change in the product: it decides which AWS account Cloudwise
  // reads and, where a remediation role is supplied, can modify. account:write
  // excludes viewer and finops.
  R(['POST', 'PATCH', 'DELETE'], /^\/api\/aws\/connections/,   'account:write'),
  R(['GET'],  /^\/api\/aws\/connections/,                      'account:read'),

  // ── Cost fact store ───────────────────────────────────────────────────────
  // Triggering ingestion spends money on billing APIs (Cost Explorer bills per
  // request) and a backfill can issue a lot of them, so it is an account-level
  // action, not a read.
  // Refresh takes no date range and cannot backfill, so it is a read of current
  // figures rather than a configuration change — cost:read, the same permission
  // as viewing the dashboard it refreshes. Abuse is bounded by the server-side
  // cooldown, not by the permission.
  R(['POST'], /^\/api\/costs\/refresh$/,                       'cost:read'),
  R(['POST'], /^\/api\/costs\/ingest$/,                        'account:write'),
  R(['GET'],  /^\/api\/costs\/ingestion-status$/,              'account:read'),
  R(['GET'],  /^\/api\/costs\//,                               'cost:read'),

  // ── AI unit economics ─────────────────────────────────────────────────────
  // The breakdown is a cost view like any other. Entering a business
  // denominator is not: it changes every per-unit figure the organization
  // reports, which makes it a finance input rather than a preference.
  // Ingesting usage calls CloudWatch (billed per request) and writes what the
  // organization is measured on, so it is an account-level action, not a read.
  R(['POST'],   /^\/api\/ai-economics\/ingest$/,              'account:write'),
  // A model rate changes every derived figure the organization reports.
  // Fetching published rates writes what every cost figure is derived from.
  R(['POST'],   /^\/api\/ai-economics\/pricing\/refresh$/,     'budget:write'),
  R(['PUT'],    /^\/api\/ai-economics\/pricing$/,             'budget:write'),
  R(['PUT'],    /^\/api\/ai-economics\/metrics$/,             'budget:write'),
  R(['DELETE'], /^\/api\/ai-economics\/metrics\/\d+$/,         'budget:write'),
  R(['GET'],    /^\/api\/ai-economics\//,                     'cost:read'),

  // ── Governance & compliance ───────────────────────────────────────────────
  // Reading the posture is a read. Changing a policy redefines what the whole
  // organization is measured against, and granting an exemption is a decision
  // to accept the risk a policy exists to prevent — three different things, so
  // three different permissions.
  R(['POST'],   /^\/api\/governance\/exemptions$/,            'governance:exempt'),
  R(['DELETE'], /^\/api\/governance\/exemptions\/\d+$/,        'governance:exempt'),
  R(['GET'],    /^\/api\/governance\/exemptions/,             'governance:read'),
  // Acknowledging records that a finding has been seen and triaged. It does not
  // suppress it, so it stops short of needing the exemption permission.
  R(['POST'],   /^\/api\/governance\/violations\/\d+\/acknowledge$/, 'governance:write'),
  R(['GET'],    /^\/api\/governance\/violations/,             'governance:read'),
  // A sweep reads ingested data and writes findings. It spends nothing at a
  // provider, but it does change what the organization is reported as.
  R(['POST'],   /^\/api\/governance\/evaluate$/,              'governance:write'),
  R(['PUT', 'PATCH'], /^\/api\/governance\/policies\/[^/]+$/,   'governance:write'),
  R(['POST'],   /^\/api\/governance\/policies\/[^/]+\/reset$/,  'governance:write'),
  R(['GET'],    /^\/api\/governance\//,                       'governance:read'),

  // ── Users, organizations, audit ───────────────────────────────────────────
  R('*',      /^\/api\/users/,                                'user:manage'),
  R(['GET'],  /^\/api\/audit-logs/,                           'audit:read'),
  R(['GET'],  /^\/api\/organizations/,                        'cost:read'),
  R(['POST', 'PATCH', 'PUT', 'DELETE'], /^\/api\/organizations/, 'org:manage'),

  // ── Read-only analytics ───────────────────────────────────────────────────
  // POSTs here carry a query body but change no state, so they read as reads.
  R(['GET', 'POST'], /^\/api\/cost-data/,                     'cost:read'),
  R(['POST'], /^\/api\/analyze$/,                             'cost:read'),
  R(['POST'], /^\/api\/forecast$/,                            'cost:read'),
  R(['GET'],  /^\/api\/forecast\//,                           'cost:read'),
  R(['POST'], /^\/api\/cost-estimator\//,                     'cost:read'),
  R(['GET'],  /^\/api\/anomalies/,                            'cost:read'),
  R(['GET'],  /^\/api\/services/,                             'cost:read'),
  R(['GET'],  /^\/api\/multi-cloud\//,                        'cost:read'),
  R(['GET'],  /^\/api\/resources/,                            'cost:read'),
  R(['GET'],  /^\/api\/tags\//,                               'cost:read'),
  // Running a measurement only reads ingested data and writes a result row, so
  // it is not an infrastructure action — but it does change reported figures,
  // which makes it more than a read.
  R(['POST'], /^\/api\/savings\/measurements\/run$/,           'agent:propose'),
  R(['GET'],  /^\/api\/savings\//,                            'cost:read'),
  R(['GET'],  /^\/api\/aws\/account-summaries/,               'cost:read'),
];

/**
 * Routes the auth guard already lets through unauthenticated.
 *
 * The two GitHub App setup callbacks are here because GitHub sends the browser
 * to them directly, as a plain top-level redirect with no cookie guaranteed to
 * survive the round trip — a session check would reject the very response the
 * flow depends on. They are not unauthenticated: the organization arrives in an
 * HMAC-signed, ten-minute `state` parameter that the handler verifies in
 * constant time before writing anything. Nothing else may be added here; new
 * endpoints go in RULES.
 */
const EXEMPT = /^\/api\/(health$|auth\/|infra\/git\/app\/(setup|installed)$)/;

/** Exported for tests: the authorization surface should be assertable directly. */
export function findRule(method: string, path: string): Rule | undefined {
  return RULES.find(r =>
    (r.methods === '*' || (r.methods as string[]).includes(method)) && r.pattern.test(path)
  );
}

/** Exported for tests: which permission a request would require, if any. */
export function requiredPermission(method: string, path: string): Permission | null {
  if (EXEMPT.test(path)) return null;
  return findRule(method, path)?.permission ?? null;
}

export function routePolicy(req: Request, res: Response, next: NextFunction) {
  if (!req.path.startsWith('/api') || EXEMPT.test(req.path)) return next();

  const rule = findRule(req.method, req.path);

  if (!rule) {
    // Fail closed. If you are seeing this for a legitimate new endpoint, add it
    // to RULES above — do not widen the exemption.
    console.error(`[RoutePolicy] No policy for ${req.method} ${req.path} — denying.`);
    void recordAudit({
      action: 'authz.no_policy', outcome: 'denied',
      method: req.method, path: req.path, statusCode: 403,
    });
    return res.status(403).json({
      error: 'Forbidden',
      detail: 'This endpoint has no authorization policy configured.',
    });
  }

  const role = normalizeRole(req.session?.role);
  if (!roleHasPermission(role, rule.permission)) {
    void recordAudit({
      action: 'authz.denied', outcome: 'denied',
      method: req.method, path: req.path, statusCode: 403,
      metadata: { requiredPermission: rule.permission, role },
    });
    return res.status(403).json({
      error: 'Forbidden',
      detail: `This action requires the '${rule.permission}' permission; your role is '${role}'.`,
    });
  }

  next();
}

/**
 * Boot-time coverage check.
 *
 * Walks the routes Express actually registered and reports any that no rule
 * matches. Catches a missing policy at startup, in the deploy logs, rather than
 * when a user hits an unexplained 403.
 */
export function reportRoutePolicyGaps(app: Express) {
  const stack: any[] = (app as any)?._router?.stack ?? [];
  const gaps: string[] = [];

  for (const layer of stack) {
    const path: string | undefined = layer?.route?.path;
    if (typeof path !== 'string' || !path.startsWith('/api') || EXEMPT.test(path)) continue;

    for (const method of Object.keys(layer.route.methods ?? {})) {
      const upper = method.toUpperCase();
      // Express path params (:id) are not literals; substitute a number so the
      // rule patterns, which match real request paths, can be tested.
      const concrete = path.replace(/:[^/]+/g, '1');
      if (!findRule(upper, concrete)) gaps.push(`${upper} ${path}`);
    }
  }

  if (gaps.length > 0) {
    console.warn(
      `[RoutePolicy] ${gaps.length} route(s) have no authorization policy and will return 403:\n  ` +
      gaps.join('\n  ')
    );
  } else {
    console.log('[RoutePolicy] All registered API routes have an authorization policy.');
  }
}
