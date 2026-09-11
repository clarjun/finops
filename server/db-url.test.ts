/**
 * Refusing to reach a remote database in plaintext.
 *
 * node-postgres does not enable TLS on its own. Verified against
 * pg-connection-string 2.7.0, a URL with no `sslmode` yields `ssl = undefined`,
 * which is a plaintext connection. Against Azure that fails with an opaque
 * "SSL connection is required"; against any server configured to permit
 * plaintext it succeeds, and the database password plus every row crosses the
 * network in the clear. The second case is the dangerous one, because it looks
 * like it works.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { inspectDatabaseUrl, assertDatabaseUrlIsSafe } from './db-url';

const AZURE = 'postgresql://u:p@cw.postgres.database.azure.com:5432/db';
const LOCAL = 'postgresql://postgres:p@localhost:5432/cloud_cost_agent';

afterEach(() => vi.restoreAllMocks());

describe('inspectDatabaseUrl', () => {
  it('flags a remote host with no sslmode as insecure', () => {
    const v = inspectDatabaseUrl(AZURE);
    expect(v.isLocal).toBe(false);
    expect(v.sslmode).toBeNull();
    expect(v.insecure).toBe(true);
  });

  it('accepts a remote host with sslmode=require', () => {
    const v = inspectDatabaseUrl(`${AZURE}?sslmode=require`);
    expect(v.insecure).toBe(false);
    expect(v.warning).toBeUndefined();
  });

  it('treats sslmode=disable on a remote host as insecure', () => {
    // Explicitly asking for plaintext to a remote server is still plaintext.
    expect(inspectDatabaseUrl(`${AZURE}?sslmode=disable`).insecure).toBe(true);
  });

  it('warns about sslmode=no-verify without failing it', () => {
    // Encrypted but unauthenticated: no eavesdropping, no impostor detection.
    // A deliberate choice someone may have made, so warn rather than refuse.
    const v = inspectDatabaseUrl(`${AZURE}?sslmode=no-verify`);
    expect(v.insecure).toBe(false);
    expect(v.warning).toMatch(/does not verify the server certificate/);
  });

  it('leaves local plaintext alone', () => {
    // Never crosses a network, and requiring TLS locally would break every
    // default Postgres install.
    for (const host of ['localhost', '127.0.0.1']) {
      const v = inspectDatabaseUrl(`postgresql://postgres:p@${host}:5432/db`);
      expect(v.isLocal, host).toBe(true);
      expect(v.insecure, host).toBe(false);
    }
  });
});

describe('assertDatabaseUrlIsSafe', () => {
  it('refuses to boot against a remote database in plaintext', () => {
    expect(() => assertDatabaseUrlIsSafe(AZURE)).toThrow(/plaintext/i);
    // The message has to say what to do, not just what is wrong.
    expect(() => assertDatabaseUrlIsSafe(AZURE)).toThrow(/sslmode=require/);
  });

  it('permits a correctly configured Azure URL', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(() => assertDatabaseUrlIsSafe(`${AZURE}?sslmode=require`)).not.toThrow();
  });

  it('permits local development', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(() => assertDatabaseUrlIsSafe(LOCAL)).not.toThrow();
  });

  it('explains an unset DATABASE_URL with both connection shapes', () => {
    // This is the first thing a new deployment gets wrong.
    expect(() => assertDatabaseUrlIsSafe(undefined)).toThrow(/DATABASE_URL is not set/);
    expect(() => assertDatabaseUrlIsSafe(undefined)).toThrow(/postgres\.database\.azure\.com/);
  });

  it('rejects a malformed URL rather than passing it to the pool', () => {
    expect(() => assertDatabaseUrlIsSafe('not-a-url')).toThrow(/not a valid connection URL/);
  });

  it('does not warn on a verified remote connection', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    assertDatabaseUrlIsSafe(`${AZURE}?sslmode=require`);
    expect(warn).not.toHaveBeenCalled();
  });
});
