import { describe, it, expect, vi, afterEach } from 'vitest';
import { inspectSessionSecret, assertSessionSecretIsSafe, DEV_SESSION_SECRET } from './session-policy';

afterEach(() => vi.restoreAllMocks());

describe('inspectSessionSecret', () => {
  it('rejects an unset secret', () => {
    expect(inspectSessionSecret(undefined).ok).toBe(false);
    expect(inspectSessionSecret('').ok).toBe(false);
    expect(inspectSessionSecret('   ').ok).toBe(false);
  });

  it('rejects the shipped development placeholder', () => {
    // The one that matters. It is printed in server/index.ts, so anyone who has
    // read the repository can forge a cookie for any user in any tenant.
    const verdict = inspectSessionSecret(DEV_SESSION_SECRET);
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toMatch(/placeholder/i);
  });

  it('rejects a secret that is too short to be worth signing with', () => {
    expect(inspectSessionSecret('a1b2c3d4e5f6g7h8').ok).toBe(false);
  });

  it('accepts a long random secret', () => {
    expect(inspectSessionSecret('Zk3p9QxL7vRt2NmYw8Hs4Jd6Fb1Cg5Ae0Ui').ok).toBe(true);
  });

  it('warns about a long secret with almost no variety', () => {
    // Length alone does not make a key unguessable, and "aaaa…" passes a naive
    // length check while being trivially brute-forced.
    const verdict = inspectSessionSecret('a'.repeat(64));
    expect(verdict.ok).toBe(true);
    expect(verdict.warning).toBeDefined();
  });
});

describe('assertSessionSecretIsSafe', () => {
  it('refuses to boot production with an unsafe secret', () => {
    expect(() => assertSessionSecretIsSafe(DEV_SESSION_SECRET, 'production')).toThrow(/placeholder/i);
    expect(() => assertSessionSecretIsSafe(undefined, 'production')).toThrow(/not set/i);
  });

  it('warns but continues in development', () => {
    // Refusing to start a local dev server over this would get the check
    // deleted rather than fixed.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => assertSessionSecretIsSafe(undefined, 'development')).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });

  it('stays silent for a good secret', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => assertSessionSecretIsSafe('Zk3p9QxL7vRt2NmYw8Hs4Jd6Fb1Cg5Ae0Ui', 'production')).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });
});
