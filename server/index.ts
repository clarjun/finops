// IMPORTANT: load env vars as a side-effect import on the very first line.
// In ESM, all `import` statements run before any body statement, so a later
// `dotenv.config()` call would execute AFTER ./db creates its pool — leaving
// DATABASE_URL undefined and silently falling back to local PG* defaults.
import "dotenv/config";

import express, { type Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool } from "./db";
import { assertDatabaseUrlIsSafe } from "./db-url";
import { registerRoutes } from "./routes";
import { registerAuthRoutes } from "./auth";
import { installAuthGuard } from "./middleware/auth-guard";
import { routePolicy, reportRoutePolicyGaps } from "./middleware/route-policy";
import { installSecurityHeaders } from "./middleware/security-headers";
import { installRateLimits, authLimiter } from "./middleware/rate-limit";
import { installCsrfProtection } from "./middleware/csrf";
import { assertSessionSecretIsSafe } from "./session-policy";
import { auditMiddleware } from "./audit";
import { registerAuditRoutes } from "./audit-routes";
import { registerCostFactRoutes } from "./ingestion/routes";
import { registerSavingsRoutes } from "./savings/routes";
import { registerGovernanceRoutes } from "./governance/routes";
import { registerAiEconomicsRoutes } from "./ai-economics/routes";
import { startIngestionScheduler } from "./ingestion/scheduler";
import { startReportScheduler } from "./reports/scheduler";
import { startGovernanceScheduler } from "./governance/scheduler";
import { registerInfraAgentRoutes } from "./infra-agent/routes";
import { registerAwsConnectionRoutes } from "./aws/connection-routes";
import { startInfraWorker } from "./infra-agent/worker";
import { registerTerraformTools } from "./infra-agent/tools/terraform-tools";
import { log } from "./vite";
import { serveStatic } from "./static";
import { startBudgetAlertScheduler } from "./utils/budget-alert-checker-new";

// Fail before serving traffic, not on the first query. node-postgres does not
// enable TLS unless the URL asks for it, so a production DATABASE_URL missing
// ?sslmode=require would send the password and every row in plaintext to any
// server that tolerates it — a failure that looks like success.
assertDatabaseUrlIsSafe(process.env.DATABASE_URL);

// Same reasoning, applied to the session key. A production deployment running
// on the development placeholder below lets anyone who has read this repository
// forge a session cookie for any user in any tenant, including an owner. That
// is not a warning-level problem, so it is not a warning.
assertSessionSecretIsSafe(process.env.SESSION_SECRET, process.env.NODE_ENV);

const app = express();

// Before anything else, so that even a 500 from a parser carries them.
installSecurityHeaders(app, process.env.NODE_ENV === 'production');
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Trust Azure Container Apps reverse proxy
app.set('trust proxy', 1);

// Session middleware — persistent Postgres-backed store so sessions survive
// container restarts and are shared across replicas (Azure Container Apps).
const PgSession = connectPgSimple(session);
app.use(session({
  store: new PgSession({
    pool,
    tableName: 'user_sessions',
    createTableIfMissing: true,
  }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  },
}));

// After the session so limits can be keyed per user rather than per IP — an
// office behind one NAT address is a single IP and many legitimate people.
app.use('/api/auth/login', authLimiter);
installRateLimits(app);

// After the session (it reads and writes the session's token) and before any
// route. Production issues cookies with sameSite:'none', which removes the
// browser's own CSRF defence, so this is what replaces it.
installCsrfProtection(app);

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      // Response bodies are NOT logged. This line used to append the serialized
      // JSON of every API response, which put cloud account identifiers, user
      // records and error details carrying credential fragments into stdout —
      // and container stdout is shipped to a log aggregator that a far wider
      // group can read than the database itself.
      if (capturedJsonResponse && typeof capturedJsonResponse === 'object') {
        logLine += ` :: ${Object.keys(capturedJsonResponse).slice(0, 8).join(',')}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  // Order matters. The guard authenticates and establishes the tenant context
  // that every downstream handler and the audit writer read from, so it must be
  // installed before any API route is registered — Express only applies
  // middleware to routes added after it.
  installAuthGuard(app);
  app.use(routePolicy);
  app.use(auditMiddleware);

  const server = await registerRoutes(app);
  registerAuthRoutes(app);
  registerAuditRoutes(app);
  registerCostFactRoutes(app);
  registerSavingsRoutes(app);
  registerGovernanceRoutes(app);
  registerAiEconomicsRoutes(app);
  registerInfraAgentRoutes(app);
  // Cross-account IAM role onboarding and validation for AWS.
  registerAwsConnectionRoutes(app);

  // Surfaces any endpoint that slipped past the policy table, in the boot log.
  reportRoutePolicyGaps(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    // Log rather than rethrow: the response has already been sent, so throwing
    // here escapes to an unhandled rejection and can take the process down
    // instead of producing a useful record.
    console.error('[Unhandled]', err?.stack ?? err);
    // An unhandled 500 carries a driver or stack message that names tables,
    // columns and sometimes connection strings. In production the client gets
    // the status and nothing else; the detail stays in the log above, where it
    // is actually useful.
    const isProduction = process.env.NODE_ENV === 'production';
    res.status(status).json({
      message: isProduction && status >= 500 ? 'Internal Server Error' : message,
    });
  });

  if (process.env.NODE_ENV === "development") {
    // ✅ setupVite dynamically imported — vite never loads in production
    const { setupVite } = await import("./vite.js");
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const port = parseInt(process.env.PORT || '5173', 10);
  server.listen(port, "0.0.0.0", () => {
    log(`✅ Server running on http://localhost:${port}`);
    startBudgetAlertScheduler(60);
    log('Budget alert scheduler started');

    // Cost ingestion. Opt-out via INGESTION_ENABLED=false for environments that
    // should not spend money on billing APIs (a shared dev box, CI).
    if (process.env.INGESTION_ENABLED !== 'false') {
      startIngestionScheduler(Number(process.env.INGESTION_INTERVAL_HOURS) || 6);
      log('Cost ingestion scheduler started');
    } else {
      log('Cost ingestion scheduler disabled (INGESTION_ENABLED=false)');
    }

    // Scheduled report delivery. Previously configurable in the UI but never
    // executed — getDueReportSchedules() had no caller.
    startReportScheduler(Number(process.env.REPORT_INTERVAL_MINUTES) || 15);
    log('Report scheduler started');

    // Governance evaluation. Slower than ingestion on purpose: evaluating more
    // often than the cost data behind it refreshes produces identical findings
    // at real database cost. Opt out with GOVERNANCE_ENABLED=false.
    if (process.env.GOVERNANCE_ENABLED !== 'false') {
      startGovernanceScheduler(Number(process.env.GOVERNANCE_INTERVAL_HOURS) || 6);
      log('Governance scheduler started');
    } else {
      log('Governance scheduler disabled (GOVERNANCE_ENABLED=false)');
    }

    // Infrastructure agent. Tools are registered before the worker starts, so a
    // run picked up on the first sweep cannot find an empty registry.
    registerTerraformTools();
    startInfraWorker(Number(process.env.INFRA_SWEEP_SECONDS) || 30);
    log('Infrastructure deployment agent started');
  });
})();