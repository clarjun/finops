/**
 * Security response headers.
 *
 * Hand-rolled rather than pulled from helmet, for one reason that matters here:
 * the policy below has to be read and argued with by whoever reviews this
 * product's security, and a dependency whose defaults change between minor
 * versions moves that policy out of review. There are about forty lines of
 * header values; the indirection is not worth the audit cost.
 *
 * The CSP is the only interesting part. The console renders cost data and, in
 * the AI query view, model output — so a script injected into either has a
 * direct path to every figure in the tenant and to the session that can add
 * cloud credentials. `default-src 'self'` with no wildcard host is what makes
 * an injected script unable to send anything anywhere.
 *
 * Development is deliberately looser: Vite serves modules over a websocket with
 * an inline preamble, and a policy that breaks the dev server would simply be
 * turned off by the next person.
 */
import type { Express, Request, Response, NextFunction } from "express";
import { markSecurityMiddlewareInstalled } from "../governance/data";

/** Google Fonts is the only third-party origin the client index.html loads. */
const FONT_CSS = 'https://fonts.googleapis.com';
const FONT_FILES = 'https://fonts.gstatic.com';

function productionCsp(): string {
  return [
    "default-src 'self'",
    // No 'unsafe-inline' and no 'unsafe-eval': the production bundle loads as a
    // module with a src, so neither is needed, and adding either would make the
    // rest of this policy close to decorative.
    "script-src 'self'",
    // Styles do need it. Radix and Tailwind both write inline style attributes
    // for animation and positioning, and a nonce cannot cover attributes.
    `style-src 'self' 'unsafe-inline' ${FONT_CSS}`,
    `font-src 'self' ${FONT_FILES} data:`,
    "img-src 'self' data: blob:",
    // Same-origin only. The API, and nothing else — an injected script has
    // nowhere to exfiltrate to.
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    // Belt and braces with X-Frame-Options below; frame-ancestors is the one
    // modern browsers actually honour.
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join('; ');
}

function developmentCsp(): string {
  return [
    "default-src 'self'",
    // Vite injects an inline module preamble and uses eval for HMR.
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    `style-src 'self' 'unsafe-inline' ${FONT_CSS}`,
    `font-src 'self' ${FONT_FILES} data:`,
    "img-src 'self' data: blob:",
    // The HMR websocket.
    "connect-src 'self' ws: wss:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function securityHeaders(isProduction: boolean) {
  const csp = isProduction ? productionCsp() : developmentCsp();

  return function (req: Request, res: Response, next: NextFunction) {
    res.setHeader('Content-Security-Policy', csp);

    // Stops a browser from guessing that a JSON error body is HTML and running
    // it — the classic path from "an API echoed user input" to stored XSS.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    // Referrers leak the account ids and resource names that appear in our
    // paths. Origin-only is enough for any analytics we would ever add.
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    // Nothing in a cost console needs a camera, a microphone or a location.
    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    );
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');

    if (isProduction) {
      // Two years, subdomains included. Only sent in production: setting HSTS
      // from a localhost dev server would pin the developer's browser to HTTPS
      // for every other localhost project they own.
      res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    }

    // API responses carry cost data and, on some endpoints, connection metadata.
    // A shared proxy caching them would serve one tenant's figures to another.
    if (req.path.startsWith('/api')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      res.setHeader('Pragma', 'no-cache');
    }

    next();
  };
}

export function installSecurityHeaders(app: Express, isProduction: boolean): void {
  app.disable('x-powered-by');   // stops advertising the framework and version
  app.use(securityHeaders(isProduction));
  markSecurityMiddlewareInstalled('securityHeaders');
}
