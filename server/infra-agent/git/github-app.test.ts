/**
 * The JWT is the part that fails opaquely.
 *
 * A wrong claim, a wrong encoding or a clock an hour out all surface as the
 * same GitHub 401, which reads like a bad private key and sends whoever is
 * debugging it to regenerate a key that was fine. So the token is verified
 * here against a real RSA key rather than trusted.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPairSync, createVerify } from 'crypto';
import {
  mintAppJwt, normalizePrivateKey, buildManifest, type AppCredentials,
} from './github-app';

let publicKey: string;
let creds: AppCredentials;

beforeAll(() => {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  publicKey = pair.publicKey;
  creds = { appId: '123456', privateKey: pair.privateKey, slug: 'cloudwise-infra' };
});

const decode = (jwt: string) => {
  const [h, p] = jwt.split('.');
  return {
    header: JSON.parse(Buffer.from(h, 'base64url').toString()),
    payload: JSON.parse(Buffer.from(p, 'base64url').toString()),
  };
};

describe('mintAppJwt', () => {
  it('produces a signature GitHub can actually verify', () => {
    const jwt = mintAppJwt(creds);
    const [h, p, sig] = jwt.split('.');

    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${h}.${p}`);
    verifier.end();

    expect(verifier.verify(publicKey, Buffer.from(sig, 'base64url'))).toBe(true);
  });

  it('claims RS256 and the app id, which is all GitHub reads', () => {
    const { header, payload } = decode(mintAppJwt(creds));
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(payload.iss).toBe('123456');
  });

  it('backdates iat so a fast server clock does not look like a bad key', () => {
    // GitHub rejects a token issued "in the future". A server 30s ahead would
    // otherwise 401 on every request with an error blaming the private key.
    const now = 1_800_000_000_000;
    const { payload } = decode(mintAppJwt(creds, now));
    expect(payload.iat).toBeLessThan(Math.floor(now / 1000));
  });

  it('expires inside the 10 minutes GitHub allows', () => {
    // Over 600s and GitHub refuses the token outright.
    const now = 1_800_000_000_000;
    const { payload } = decode(mintAppJwt(creds, now));
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
    expect(payload.exp).toBeGreaterThan(Math.floor(now / 1000));
  });

  it('uses base64url, not base64', () => {
    // A '+' or '/' in the encoding makes the token unparseable to GitHub, and
    // only for SOME keys — the ones whose signature happens to contain them.
    for (let i = 0; i < 20; i++) {
      expect(mintAppJwt(creds, 1_800_000_000_000 + i * 1000)).not.toMatch(/[+/=]/);
    }
  });

  it('explains an unusable key instead of leaking a crypto error', () => {
    expect(() => mintAppJwt({ ...creds, privateKey: 'not a key' }))
      .toThrow(/private key is not a usable RSA key/i);
  });
});

describe('normalizePrivateKey', () => {
  it('accepts a PEM whose newlines survived as backslash-n', () => {
    // How a key arrives after a round trip through JSON or a form field.
    const mangled = creds.privateKey.split('\n').join('\\n');
    const got = normalizePrivateKey(mangled);

    expect(got).toContain('-----BEGIN');
    // And it must actually sign, not merely look like a key.
    expect(() => mintAppJwt({ ...creds, privateKey: got! })).not.toThrow();
  });

  it('accepts a base64-encoded key file', () => {
    const got = normalizePrivateKey(Buffer.from(creds.privateKey).toString('base64'));

    expect(got).toContain('-----BEGIN');
    expect(() => mintAppJwt({ ...creds, privateKey: got! })).not.toThrow();
  });

  it('passes an already-clean PEM through untouched', () => {
    expect(normalizePrivateKey(creds.privateKey)).toBe(creds.privateKey.trim());
  });

  it('rejects anything that is not a key, instead of returning it', () => {
    // A personal access token pasted into the key field is the likely mistake,
    // and returning it would surface as a signing error much later.
    expect(normalizePrivateKey('ghp_thisIsAPersonalAccessToken')).toBeNull();
    expect(normalizePrivateKey('')).toBeNull();
    expect(normalizePrivateKey('not a key at all')).toBeNull();
  });
});

describe('buildManifest', () => {
  const m = () => buildManifest('CloudWise Infra (1)', 'https://app.example.com/');

  it('asks for the minimum permissions the flow needs', () => {
    // Every extra permission is one a security reviewer has to justify, and
    // one more thing a compromised installation could reach.
    expect(m().default_permissions).toEqual({
      contents: 'write',
      pull_requests: 'write',
      metadata: 'read',
    });
  });

  it('turns webhooks off', () => {
    // Nothing here listens. Leaving them on means GitHub retries deliveries
    // into a void and shows the customer a page of failures on their own App.
    expect((m().hook_attributes as any).active).toBe(false);
    expect(m().default_events).toEqual([]);
  });

  it('is not listed publicly', () => {
    expect(m().public).toBe(false);
  });

  it('points both callbacks at this deployment, without a doubled slash', () => {
    expect(m().redirect_url).toBe('https://app.example.com/api/infra/git/app/setup');
    expect(m().setup_url).toBe('https://app.example.com/api/infra/git/app/installed');
  });

  it('returns to the app after an installation is changed, not only created', () => {
    // Without this, adding a repository to an existing installation leaves the
    // customer on GitHub with no way back and a stale dropdown.
    expect(m().setup_on_update).toBe(true);
  });
});
