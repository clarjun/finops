/**
 * Request rate limiting.
 *
 * Three limiters with different jobs:
 *
 *   authLimiter      — per IP AND per username, on the sign-in endpoint. This
 *                      is the one that matters: without it, password guessing
 *                      is bounded only by network speed.
 *   expensiveLimiter — on endpoints that call a cloud billing API or a model.
 *                      Those cost real money per request, so the limit protects
 *                      the bill, not just the CPU.
 *   apiLimiter       — a wide backstop on everything else.
 *
 * In-process counters, not Redis. The honest limitation: with N replicas behind
 * Azure Container Apps, an attacker gets N times the configured allowance. That
 * is a real weakening and it is stated rather than hidden — but the alternative
 * shape of this bug is no limit at all, and the durable lockout in
 * server/auth.ts is what actually stops credential stuffing across replicas.
 * Swap the store for Redis when a second replica becomes the norm.
 */
import type { Request, Response, NextFunction } from "express";
import { markSecurityMiddlewareInstalled } from "../governance/data";
import { recordAudit } from "../audit";

interface Bucket {
  count: number;
  /** When the current window ends, in epoch ms. */
  resetAt: number;
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Shown to the client and written to the audit entry. */
  label: string;
  /** Defaults to the client IP. Return null to skip limiting this request. */
  key?: (req: Request) => string | null;
  /** Don't count requests that succeeded — used so a correct login is free. */
  skipSuccessful?: boolean;
}

/**
 * Buckets live in a Map that is swept lazily on write.
 *
 * A setInterval sweeper would keep the event loop alive and would have to be
 * cleared in tests; sweeping on the same path that grows the map is simpler and
 * bounds it just as well.
 */
const SWEEP_EVERY = 500;

export function createRateLimiter(options: RateLimitOptions) {
  const buckets = new Map<string, Bucket>();
  let writesSinceSweep = 0;

  function sweep(now: number) {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }

  return function rateLimit(req: Request, res: Response, next: NextFunction) {
    const key = options.key ? options.key(req) : clientIp(req);
    if (key === null) return next();

    const now = Date.now();
    if (++writesSinceSweep >= SWEEP_EVERY) {
      writesSinceSweep = 0;
      sweep(now);
    }

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + options.windowMs };
      buckets.set(key, bucket);
    }

    if (bucket.count >= options.max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      res.setHeader('RateLimit-Limit', String(options.max));
      res.setHeader('RateLimit-Remaining', '0');
      res.setHeader('RateLimit-Reset', String(retryAfter));

      // Worth an audit entry: a burst of these is what a credential-stuffing
      // run looks like from the inside.
      void recordAudit({
        action: 'security.rate_limited',
        outcome: 'denied',
        method: req.method,
        path: req.path,
        statusCode: 429,
        metadata: { limiter: options.label, retryAfterSeconds: retryAfter },
      });

      return res.status(429).json({
        error: 'Too many requests',
        detail: `Rate limit for ${options.label} exceeded. Try again in ${retryAfter} second${retryAfter === 1 ? '' : 's'}.`,
        retryAfterSeconds: retryAfter,
      });
    }

    bucket.count += 1;
    res.setHeader('RateLimit-Limit', String(options.max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, options.max - bucket.count)));

    if (options.skipSuccessful) {
      // Refund the attempt if it turned out to be a legitimate one. A user who
      // signs in correctly should never be able to lock themselves out by
      // signing in again.
      res.on('finish', () => {
        if (res.statusCode < 400 && bucket!.count > 0) bucket!.count -= 1;
      });
    }

    next();
  };
}

export function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  return req.ip ?? 'unknown';
}

/**
 * Sign-in. Ten attempts per IP per fifteen minutes, successful ones refunded.
 *
 * Paired with the per-account lockout in server/auth.ts, which is durable and
 * therefore survives both a restart and a second replica.
 */
export const authLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  label: 'sign-in',
  skipSuccessful: true,
});

/**
 * Endpoints that spend money per call — Cost Explorer is billed per request,
 * and the AI endpoints are billed per token.
 */
export const expensiveLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 20,
  label: 'billing and AI operations',
  // Per user rather than per IP: a whole office behind one NAT address is one
  // IP and many legitimate users.
  key: (req) => (req.session?.userId ? `user:${req.session.userId}` : clientIp(req)),
});

/** Wide backstop. High enough that a dashboard load with twenty parallel widgets is unaffected. */
export const apiLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 600,
  label: 'API requests',
  key: (req) => (req.session?.userId ? `user:${req.session.userId}` : clientIp(req)),
});

/** Paths whose cost is paid to a provider rather than in CPU. */
const EXPENSIVE = [
  /^\/api\/costs\/(ingest|refresh)$/,
  /^\/api\/ai\//,
  /^\/api\/analyze$/,
  /^\/api\/query$/,
  /^\/api\/optimization\/recommendations\/generate$/,
  /^\/api\/governance\/evaluate$/,
  /^\/api\/reports\/generate/,
  /^\/api\/infra\/steps\/research$/,
];

export function installRateLimits(app: import("express").Express): void {
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api')) return next();
    if (EXPENSIVE.some(p => p.test(req.path))) return expensiveLimiter(req, res, next);
    return apiLimiter(req, res, next);
  });
  markSecurityMiddlewareInstalled('rateLimit');
}
