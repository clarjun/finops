// IMPORTANT: load env vars as a side-effect import on the very first line.
// In ESM, all `import` statements run before any body statement, so a later
// `dotenv.config()` call would execute AFTER ./db creates its pool — leaving
// DATABASE_URL undefined and silently falling back to local PG* defaults.
import "dotenv/config";

import express, { type Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool } from "./db";
import { registerRoutes } from "./routes";
import { registerAuthRoutes } from "./auth";
import { installAuthGuard } from "./middleware/auth-guard";
import { routePolicy, reportRoutePolicyGaps } from "./middleware/route-policy";
import { auditMiddleware } from "./audit";
import { registerAuditRoutes } from "./audit-routes";
import { registerCostFactRoutes } from "./ingestion/routes";
import { registerSavingsRoutes } from "./savings/routes";
import { startIngestionScheduler } from "./ingestion/scheduler";
import { startReportScheduler } from "./reports/scheduler";
import { log } from "./vite";
import { serveStatic } from "./static";
import { startBudgetAlertScheduler } from "./utils/budget-alert-checker-new";

const app = express();
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
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
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

  // Surfaces any endpoint that slipped past the policy table, in the boot log.
  reportRoutePolicyGaps(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    // Log rather than rethrow: the response has already been sent, so throwing
    // here escapes to an unhandled rejection and can take the process down
    // instead of producing a useful record.
    console.error('[Unhandled]', err?.stack ?? err);
    res.status(status).json({ message });
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
  });
})();