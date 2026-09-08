/**
 * Entra federation: claim decoding and availability gating.
 *
 * The token exchange itself needs Azure and AWS, so it is not unit-testable.
 * What IS testable is the part that actually goes wrong in practice: reading the
 * real claims out of a token so the AWS side can be configured to match, and
 * refusing to attempt federation when the platform identity is absent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  decodeTokenClaims,
  isFederationAvailable,
  invalidateFederatedCredentials,
  entraFederatedCredentials,
} from './entra-federation';

/** Builds an unsigned JWT with the given payload. Signature is irrelevant here. */
function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}.fake-signature`;
}

const ENV_KEYS = [
  'AWS_FEDERATION_ROLE_ARN', 'AWS_FEDERATION_AUDIENCE',
  'IDENTITY_ENDPOINT', 'IDENTITY_HEADER', 'MSI_ENDPOINT', 'MSI_SECRET',
  'AZURE_CLIENT_ID_FOR_AWS',
];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  invalidateFederatedCredentials();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('claim decoding', () => {
  it('extracts the values AWS must be configured to match', () => {
    // A realistic Azure managed-identity token: note the v1 issuer form with a
    // trailing slash, which is what actually gets issued.
    const token = makeJwt({
      iss: 'https://sts.windows.net/a858d9da-8dfa-4b12-9f90-d0448a34f6d1/',
      aud: 'api://cloudwise-aws',
      sub: '26012739-3f32-4138-8570-1e9a544776aa',
      exp: 1800000000,
    });

    expect(decodeTokenClaims(token)).toEqual({
      issuer: 'https://sts.windows.net/a858d9da-8dfa-4b12-9f90-d0448a34f6d1/',
      audience: 'api://cloudwise-aws',
      subject: '26012739-3f32-4138-8570-1e9a544776aa',
      expiresAt: new Date(1800000000 * 1000).toISOString(),
    });
  });

  it('handles an array audience', () => {
    const token = makeJwt({ iss: 'https://x/', aud: ['a', 'b'], sub: 's' });
    expect(decodeTokenClaims(token).audience).toBe('a,b');
  });

  it('returns nulls for a malformed token rather than throwing', () => {
    // Called on the error path, where throwing would replace a useful AWS error
    // with a parse failure.
    for (const bad of ['', 'not-a-jwt', 'a.b', 'a.!!!notbase64!!!.c']) {
      expect(() => decodeTokenClaims(bad)).not.toThrow();
      expect(decodeTokenClaims(bad).issuer).toBeNull();
    }
  });

  it('never returns the signature', () => {
    const token = makeJwt({ iss: 'https://x/', sub: 's' });
    const claims = decodeTokenClaims(token);
    expect(JSON.stringify(claims)).not.toContain('fake-signature');
  });
});

describe('availability gating', () => {
  it('is unavailable with no configuration at all', () => {
    expect(isFederationAvailable()).toBe(false);
    expect(entraFederatedCredentials()).toBeNull();
  });

  it('is unavailable when configured but not running on Azure', () => {
    // The developer-laptop case. Must fall through to the default chain rather
    // than fail, or the same build could not run locally.
    process.env.AWS_FEDERATION_ROLE_ARN = 'arn:aws:iam::123456789012:role/CloudwiseFederatedRole';
    process.env.AWS_FEDERATION_AUDIENCE = 'api://cloudwise-aws';

    expect(isFederationAvailable()).toBe(false);
    expect(entraFederatedCredentials()).toBeNull();
  });

  it('is unavailable on Azure when the role ARN is missing', () => {
    process.env.IDENTITY_ENDPOINT = 'http://localhost/identity';
    process.env.IDENTITY_HEADER = 'header-value';
    process.env.AWS_FEDERATION_AUDIENCE = 'api://cloudwise-aws';

    // Half-configured must not read as configured: attempting the exchange with
    // no target role produces a confusing AWS error instead of a clear one.
    expect(isFederationAvailable()).toBe(false);
  });

  it('is available with both configuration and a platform identity', () => {
    process.env.AWS_FEDERATION_ROLE_ARN = 'arn:aws:iam::123456789012:role/CloudwiseFederatedRole';
    process.env.AWS_FEDERATION_AUDIENCE = 'api://cloudwise-aws';
    process.env.IDENTITY_ENDPOINT = 'http://localhost/identity';
    process.env.IDENTITY_HEADER = 'header-value';

    expect(isFederationAvailable()).toBe(true);
    expect(typeof entraFederatedCredentials()).toBe('function');
  });

  it('accepts the older MSI_ENDPOINT form of platform identity', () => {
    process.env.AWS_FEDERATION_ROLE_ARN = 'arn:aws:iam::123456789012:role/R';
    process.env.AWS_FEDERATION_AUDIENCE = 'api://cloudwise-aws';
    process.env.MSI_ENDPOINT = 'http://localhost/msi';

    expect(isFederationAvailable()).toBe(true);
  });

  it('returns a provider function, not resolved credentials', () => {
    process.env.AWS_FEDERATION_ROLE_ARN = 'arn:aws:iam::123456789012:role/R';
    process.env.AWS_FEDERATION_AUDIENCE = 'api://cloudwise-aws';
    process.env.IDENTITY_ENDPOINT = 'http://localhost/identity';
    process.env.IDENTITY_HEADER = 'h';

    // Lazy, so nothing is fetched at construction and the SDK can re-invoke it
    // when the session nears expiry.
    const provider = entraFederatedCredentials();
    expect(typeof provider).toBe('function');
  });
});
