/**
 * Cross-site request forgery protection.
 *
 * This is not optional here, and the reason is in server/index.ts: production
 * sessions are issued with `sameSite: 'none'` so the console can be hosted on a
 * different origin from the API. SameSite=Lax is what implicitly protects most
 * cookie-authenticated apps from CSRF; turning it off removes that protection
 * entirely. Without a token, any page a signed-in user visits could POST to
 * /api/agent/actions/:id/execute and have the browser attach their session.
 *
 * Two independent checks, because each covers a case the other cannot:
 *
 *   1. A synchronizer token. The value lives in the session (server side) and
 *      is handed to the browser in a readable cookie. Same-origin policy stops
 *      another origin from reading that cookie, so it cannot produce the
 *      header. Applies to every state-changing request with a session.
 *
 *   2. An Origin check. Covers the requests that have no session yet — sign-in
 *      above all — where there is no token to compare.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response, NextFunction } from "express";
import { markSecurityMiddlewareInstalled } from "../governance/data";
import { recordAudit } from "../audit";

/** Readable by JavaScript on purpose: the client has to echo it back in a header. */
export const CSRF_COOKIE = 'XSRF-TOKEN';
export const CSRF_HEADER = 'x-csrf-token';

declare module 'express-session' {
  interface SessionData {
    csrfToken?: string;
  }
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Sign-in and sign-out have no session token to compare against yet, so they
 * rely on the Origin check below. Health is a public GET in practice.
 */
const TOKEN_EXEMPT = /^\/api\/(health$|auth\/(login|logout)$)/;

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length — compare lengths first and return the same way either path.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Rejects a cross-origin state change.
 *
 * A request with neither Origin nor Referer is allowed through: that is what a
 * server-to-server call with a session cookie looks like, and browsers always
 * send at least one of the two on a cross-origin POST. Blocking on their
 * absence would break non-browser clients while stopping no attack a browser
 * can actually mount.
 */
function originAllowed(req: Request): boolean {
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  const source = typeof origin === 'string' ? origin : typeof referer === 'string' ? referer : null;
  if (!source) return true;

  let sourceHost: string;
  try {
    sourceHost = new URL(source).host;
  } catch {
    return false;   // a malformed Origin is not something to wave through
  }

  // Behind Azure Container Apps the public host arrives in X-Forwarded-Host;
  // req.get('host') would be the internal one and every request would fail.
  const forwarded = req.headers['x-forwarded-host'];
  const expected = (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : req.get('host')) ?? '';

  if (sourceHost === expected) return true;

  // An explicit allow-list for a console hosted on a different origin from the
  // API — the deployment shape that made sameSite:'none' necessary in the first
  // place.
  const allowed = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

  return allowed.some(o => {
    try { return new URL(o).host === sourceHost; } catch { return o === sourceHost; }
  });
}

/** A fresh token. Rotated on sign-in so a pre-login value can never be reused. */
export function mintCsrfToken(): string {
  return randomBytes(32).toString('hex');
}

export function setCsrfCookie(res: Response, token: string): void {
  res.cookie(CSRF_COOKIE, token, {
    // Readable by the console's fetch wrapper. Same-origin policy is what keeps
    // another site from reading it, not the httpOnly flag.
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    path: '/',
  });
}

export function clearCsrfCookie(res: Response): void {
  res.clearCookie(CSRF_COOKIE, { path: '/' });
}

/**
 * Keeps the cookie in step with the session.
 *
 * Only for authenticated sessions. Touching req.session for an anonymous
 * visitor would mark it dirty and defeat `saveUninitialized: false`, writing a
 * session row to Postgres for every unauthenticated request — including every
 * health check. Sign-in issues the first token itself, in server/auth.ts.
 */
export function issueCsrfToken(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.userId) return next();

  if (!req.session.csrfToken) req.session.csrfToken = mintCsrfToken();

  // Re-sent on every response rather than only when created: a client that
  // cleared its cookies, or a session restored from the Postgres store after a
  // restart, would otherwise have no way to obtain the token again.
  setCsrfCookie(res, req.session.csrfToken);
  next();
}

export function csrfProtection(req: Request, res: Response, next: NextFunction) {
  if (!req.path.startsWith('/api') || !MUTATING.has(req.method)) return next();

  if (!originAllowed(req)) {
    void recordAudit({
      action: 'security.csrf_blocked',
      outcome: 'denied',
      method: req.method,
      path: req.path,
      statusCode: 403,
      metadata: { reason: 'cross_origin', origin: req.headers.origin ?? null },
    });
    return res.status(403).json({
      error: 'Forbidden',
      detail: 'This request came from an origin this deployment does not accept.',
    });
  }

  if (TOKEN_EXEMPT.test(req.path)) return next();

  // No session means the auth guard is about to return 401 anyway. Answering
  // 403-CSRF here would just be a confusing way to say "not signed in".
  const expected = req.session?.csrfToken;
  if (!expected) return next();

  const header = req.headers[CSRF_HEADER];
  const provided = Array.isArray(header) ? header[0] : header;

  if (typeof provided !== 'string' || !constantTimeEquals(provided, expected)) {
    void recordAudit({
      action: 'security.csrf_blocked',
      outcome: 'denied',
      method: req.method,
      path: req.path,
      statusCode: 403,
      metadata: { reason: provided ? 'token_mismatch' : 'token_missing' },
    });
    return res.status(403).json({
      error: 'Forbidden',
      detail:
        'Missing or invalid CSRF token. Reload the page — the token is issued with the session and ' +
        'sent automatically by the console.',
    });
  }

  next();
}

/**
 * Installs both halves.
 *
 * Order matters: the token has to be issued before anything can be verified
 * against it, and both must sit before the routes they protect.
 */
export function installCsrfProtection(app: Express): void {
  app.use(issueCsrfToken);
  app.use(csrfProtection);
  markSecurityMiddlewareInstalled('csrf');
}
