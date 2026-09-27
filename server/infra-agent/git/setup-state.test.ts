/**
 * The setup callback is the one endpoint in this product that GitHub calls
 * directly, unauthenticated, in a browser. Everything protecting it is in the
 * `state` parameter, so that is what these tests are about.
 *
 * The attack being prevented: somebody registers a GitHub App they control,
 * then redeems its code against another tenant. That tenant's infrastructure
 * pull requests would then be opened by an App belonging to the attacker.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const saved = process.env.SESSION_SECRET;
beforeAll(() => { process.env.SESSION_SECRET = 'test-secret-for-setup-state'; });
afterAll(() => {
  if (saved === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = saved;
});

const load = async () => import('./routes');

describe('setup state', () => {
  it('round-trips the organization it was signed for', async () => {
    const { signSetupState, verifySetupState } = await load();
    expect(verifySetupState(signSetupState(42))).toBe(42);
  });

  it('refuses a state signed for a different organization', async () => {
    // The core attack. Swapping the org id must invalidate the signature, or a
    // code could be redeemed against somebody else's tenant.
    const { signSetupState, verifySetupState } = await load();
    const state = signSetupState(42);
    const [, ts, mac] = state.split('.');

    expect(() => verifySetupState(`999.${ts}.${mac}`)).toThrow(/failed verification/i);
  });

  it('refuses a tampered signature', async () => {
    const { signSetupState, verifySetupState } = await load();
    const [org, ts, mac] = signSetupState(7).split('.');
    const flipped = mac.slice(0, -1) + (mac.endsWith('a') ? 'b' : 'a');

    expect(() => verifySetupState(`${org}.${ts}.${flipped}`)).toThrow(/failed verification/i);
  });

  it('refuses a signature of the wrong length without throwing on the compare', async () => {
    // timingSafeEqual throws on mismatched lengths; that must surface as a
    // refusal, not as a 500 from deep inside crypto.
    const { signSetupState, verifySetupState } = await load();
    const [org, ts] = signSetupState(7).split('.');
    expect(() => verifySetupState(`${org}.${ts}.abc`)).toThrow(/failed verification/i);
  });

  it('expires', async () => {
    const { verifySetupState } = await load();
    const { createHmac } = await import('crypto');

    const stale = Date.now() - 11 * 60 * 1000;   // TTL is 10 minutes
    const payload = `5.${stale}`;
    const mac = createHmac('sha256', process.env.SESSION_SECRET!)
      .update(payload).digest('hex').slice(0, 32);

    expect(() => verifySetupState(`${payload}.${mac}`)).toThrow(/expired/i);
  });

  it('refuses missing or malformed states rather than defaulting', async () => {
    const { verifySetupState } = await load();
    expect(() => verifySetupState(null)).toThrow(/missing its state/i);
    expect(() => verifySetupState('')).toThrow(/missing its state/i);
    expect(() => verifySetupState('garbage')).toThrow(/malformed/i);
    expect(() => verifySetupState('1.2')).toThrow(/malformed/i);
  });

  it('produces a different signature per organization', async () => {
    const { signSetupState } = await load();
    const a = signSetupState(1).split('.')[2];
    const b = signSetupState(2).split('.')[2];
    expect(a).not.toBe(b);
  });
});

describe('setup result page', () => {
  it('escapes the message rather than interpolating it raw', async () => {
    // The message can carry text from GitHub's error response, which reaches
    // the page unfiltered otherwise.
    const { setupResultPage } = await load();
    const html = setupResultPage(false, '<img src=x onerror=alert(1)>');

    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('posts the outcome to the opener so the app can raise a toast', async () => {
    const { setupResultPage } = await load();
    const ok = setupResultPage(true, 'done', { installationId: '123' });

    expect(ok).toContain('cloudwise-github-setup');
    expect(ok).toContain('"installationId":"123"');
    // Targeted at our own origin, never '*'.
    expect(ok).toContain('window.location.origin');
    expect(ok).not.toContain("postMessage(payload, '*')");
  });

  it('leaves a failure on screen long enough to read', async () => {
    const { setupResultPage } = await load();
    expect(setupResultPage(false, 'nope')).toMatch(/}, 6000\)/);
    expect(setupResultPage(true, 'yes')).toMatch(/}, 1200\)/);
  });
});
