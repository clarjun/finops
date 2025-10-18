import express, { type Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import passport from "passport";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { initializePassport } from "./auth/passport";
import authRoutes from "./auth/routes";
import { Pool } from "@neondatabase/serverless";

const app = express();

// Trust proxy for secure cookies behind reverse proxy (e.g., Replit, nginx, AWS ELB)
// This is required for secure session cookies to work in production
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Check for required SESSION_SECRET in production
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  throw new Error(
    'SESSION_SECRET environment variable is required in production. ' +
    'Please set a strong, random secret (e.g., a 64-character random string).'
  );
}

const sessionSecret = process.env.SESSION_SECRET || (() => {
  const devSecret = 'dev-session-secret-change-in-production';
  log('⚠️  SESSION_SECRET not set. Using development default.');
  log('⚠️  This is INSECURE and should only be used for local development.');
  return devSecret;
})();

// PostgreSQL session store configuration
const PgSession = connectPgSimple(session);
let sessionStore;

if (process.env.DATABASE_URL) {
  const pgPool = new Pool({ connectionString: process.env.DATABASE_URL });
  sessionStore = new PgSession({
    pool: pgPool,
    tableName: 'session',
    createTableIfMissing: true,
  });
  log('Using PostgreSQL session store');
} else {
  log('⚠️  DATABASE_URL not configured. Using in-memory session store.');
  log('Sessions will not persist across server restarts.');
}

// Session configuration
app.use(
  session({
    store: sessionStore,
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    },
  })
);

// Initialize Passport
initializePassport();
app.use(passport.initialize());
app.use(passport.session());

// Mount authentication routes
app.use('/auth', authRoutes);

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

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || '5000', 10);
  server.listen({
    port,
    host: "0.0.0.0",
    reusePort: true,
  }, () => {
    log(`serving on port ${port}`);
  });
})();
