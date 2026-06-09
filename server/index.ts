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
  const server = await registerRoutes(app);
  registerAuthRoutes(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
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
  });
})();