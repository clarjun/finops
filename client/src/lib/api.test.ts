import { describe, it, expect } from 'vitest';
import { readApiError, throwIfFailed, ApiError } from './api';

const res = (status: number, body?: unknown, contentType = 'application/json'): Response =>
  new Response(
    body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body),
    { status, headers: { 'Content-Type': contentType } },
  );

describe('reading the server’s explanation', () => {
  it('prefers the server’s own message over anything invented here', async () => {
    // The case this module exists for: the Cost Estimator showed "Failed to
    // generate estimate" while the server had said exactly what was wrong.
    const err = await readApiError(
      res(500, { success: false, error: 'You have no credits remaining. Add credits to continue.' }),
      'Generating the estimate',
    );
    expect(err.message).toBe('You have no credits remaining. Add credits to continue.');
  });

  it('reads every error shape this codebase produces', async () => {
    expect((await readApiError(res(400, { error: 'A' }))).message).toBe('A');
    expect((await readApiError(res(400, { message: 'B' }))).message).toBe('B');
    expect((await readApiError(res(400, { detail: 'C' }))).message).toBe('C');
    expect((await readApiError(res(400, { success: false, error: 'D' }))).message).toBe('D');
  });

  it('keeps detail separate when both are present', async () => {
    const err = await readApiError(res(403, { error: 'Forbidden', detail: "requires 'agent:execute'" }));
    expect(err.message).toBe('Forbidden');
    expect(err.detail).toBe("requires 'agent:execute'");
  });

  it('does not duplicate a message that arrived only as detail', async () => {
    const err = await readApiError(res(400, { detail: 'Only this' }));
    expect(err.message).toBe('Only this');
    expect(err.detail).toBeUndefined();
  });

  it('carries validation issues through', async () => {
    const err = await readApiError(res(400, { error: 'Invalid request', details: [{ path: ['name'] }] }));
    expect(err.details).toEqual([{ path: ['name'] }]);
  });

  it('carries the retry hint from a rate limit', async () => {
    const err = await readApiError(res(429, { error: 'Too many requests', retryAfterSeconds: 42 }));
    expect(err.retryAfterSeconds).toBe(42);
    expect(err.retryable).toBe(true);
  });
});

describe('when the server explains nothing', () => {
  it('says something actionable per status rather than a bare code', async () => {
    // These all became reachable with the auth and rate-limiting middleware.
    // Rendering them identically is what made failures undiagnosable.
    expect((await readApiError(res(401))).message).toMatch(/session has expired/i);
    expect((await readApiError(res(403))).message).toMatch(/permission/i);
    expect((await readApiError(res(429))).message).toMatch(/Too many requests/i);
    expect((await readApiError(res(503))).message).toMatch(/temporarily unavailable/i);
  });

  it('uses the caller’s words for what was being attempted', async () => {
    expect((await readApiError(res(404), 'The budget')).message).toBe('The budget was not found.');
    expect((await readApiError(res(500), 'Loading budgets')).message).toBe('Loading budgets failed on the server (500).');
  });

  it('never shows an HTML error page to a user', async () => {
    // A proxy or a dev server returning the SPA shell would otherwise put a
    // page of markup in a toast.
    const err = await readApiError(res(502, '<!doctype html><html><body>Bad Gateway</body></html>', 'text/html'), 'Loading');
    expect(err.message).not.toContain('<');
    expect(err.message).toMatch(/temporarily unavailable/i);
  });

  it('does show a short plain-text body, which is usually the real reason', async () => {
    const err = await readApiError(res(400, 'requirements must not be empty', 'text/plain'));
    expect(err.message).toBe('requirements must not be empty');
  });

  it('survives an empty body', async () => {
    expect((await readApiError(res(500))).message).toMatch(/failed on the server/i);
  });
});

describe('throwIfFailed', () => {
  it('does nothing when the response is fine', async () => {
    await expect(throwIfFailed(res(200, { ok: true }))).resolves.toBeUndefined();
  });

  it('throws an ApiError carrying the status', async () => {
    await expect(throwIfFailed(res(404, { error: 'Nope' }))).rejects.toMatchObject({
      name: 'ApiError', status: 404, message: 'Nope',
    });
  });

  it('marks server faults and rate limits as retryable, client mistakes as not', async () => {
    // Drives whether a UI offers "try again" or tells the user to fix something.
    const retry = await readApiError(res(503));
    const permanent = await readApiError(res(400, { error: 'bad input' }));
    expect(retry.retryable).toBe(true);
    expect(permanent.retryable).toBe(false);
  });

  it('is an Error, so existing catch blocks keep working', async () => {
    const err = await readApiError(res(500));
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ApiError);
  });
});
