import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { encrypt, decrypt, isEncrypted, isLegacyFormat } from './encryption';

const KEY_A = crypto.randomBytes(32).toString('base64');
const KEY_B = crypto.randomBytes(32).toString('base64');

/** Reproduces how the old code wrote records, for the compatibility tests. */
function encryptLegacy(text: string, secret: string | null): string {
  const key = secret
    ? crypto.scryptSync(secret, 'azure-cost-dashboard-salt', 32)
    : crypto.scryptSync('default-dev-key-change-in-production', 'salt', 32);
  const salt = crypto.randomBytes(64);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return `${salt.toString('hex')}:${iv.toString('hex')}:${encrypted}:${cipher.getAuthTag().toString('hex')}`;
}

beforeEach(() => {
  process.env.ENCRYPTION_KEY = KEY_A;
  delete process.env.ENCRYPTION_KEY_PREVIOUS;
});

afterEach(() => {
  delete process.env.ENCRYPTION_KEY;
  delete process.env.ENCRYPTION_KEY_PREVIOUS;
  vi.restoreAllMocks();
});

describe('encryption round trip', () => {
  it('recovers the original text', () => {
    const secret = JSON.stringify({ accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 's3cr3t/value+here' });
    expect(decrypt(encrypt(secret))).toBe(secret);
  });

  it('handles unicode and long values', () => {
    for (const v of ['ключ-🔐-값', 'x'.repeat(10_000), '{"a":"b"}']) {
      expect(decrypt(encrypt(v))).toBe(v);
    }
  });

  it('passes empty strings straight through', () => {
    expect(encrypt('')).toBe('');
    expect(decrypt('')).toBe('');
  });

  it('produces different ciphertext each time for the same input', () => {
    // Both the salt and the IV are random per record; identical output would
    // reveal that two accounts share a credential.
    const a = encrypt('same-value');
    const b = encrypt('same-value');
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe(decrypt(b));
  });

  it('actually varies the per-record key by salt', () => {
    // The bug this replaced: the salt was stored but never used in derivation.
    // Swapping one record's salt onto another's ciphertext must therefore fail.
    const first = encrypt('value-one').split(':');
    const second = encrypt('value-two').split(':');
    const swapped = [first[0], second[1], first[2], first[3], first[4]].join(':');
    expect(() => decrypt(swapped)).toThrow();
  });
});

describe('tamper detection', () => {
  it('rejects modified ciphertext', () => {
    const parts = encrypt('sensitive').split(':');
    const flipped = parts[3].slice(0, -2) + (parts[3].endsWith('00') ? '11' : '00');
    expect(() => decrypt([parts[0], parts[1], parts[2], flipped, parts[4]].join(':'))).toThrow();
  });

  it('rejects a modified auth tag', () => {
    const parts = encrypt('sensitive').split(':');
    parts[4] = crypto.randomBytes(16).toString('hex');
    expect(() => decrypt(parts.join(':'))).toThrow();
  });

  it('rejects a malformed value', () => {
    for (const v of ['not-encrypted', 'a:b', 'v2:only:three']) {
      expect(() => decrypt(v), v).toThrow(/Invalid encrypted data format/);
    }
  });
});

describe('key handling', () => {
  it('refuses to operate without a key', () => {
    delete process.env.ENCRYPTION_KEY;
    expect(() => encrypt('x')).toThrow(/ENCRYPTION_KEY is not set/);
  });

  it('refuses a key that is too short to be random', () => {
    process.env.ENCRYPTION_KEY = 'short';
    expect(() => encrypt('x')).toThrow(/too short/);
  });

  it('fails rather than returning garbage under the wrong key', () => {
    const ciphertext = encrypt('secret-value');
    process.env.ENCRYPTION_KEY = KEY_B;
    expect(() => decrypt(ciphertext)).toThrow(/Failed to decrypt/);
  });

  it('reads records written under the previous key during rotation', () => {
    const ciphertext = encrypt('written-under-old-key');
    process.env.ENCRYPTION_KEY = KEY_B;
    process.env.ENCRYPTION_KEY_PREVIOUS = KEY_A;
    expect(decrypt(ciphertext)).toBe('written-under-old-key');
  });

  it('always writes under the current key, never the previous one', () => {
    process.env.ENCRYPTION_KEY = KEY_B;
    process.env.ENCRYPTION_KEY_PREVIOUS = KEY_A;
    const ciphertext = encrypt('new-write');

    delete process.env.ENCRYPTION_KEY_PREVIOUS;
    expect(decrypt(ciphertext)).toBe('new-write');
  });

  it('does not leak key material or ciphertext in the failure message', () => {
    const ciphertext = encrypt('confidential');
    process.env.ENCRYPTION_KEY = KEY_B;
    try {
      decrypt(ciphertext);
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err.message).not.toContain(KEY_A);
      expect(err.message).not.toContain(KEY_B);
      expect(err.message).not.toContain(ciphertext);
    }
  });
});

describe('legacy compatibility', () => {
  it('reads records written under a configured key before versioning', () => {
    const legacy = encryptLegacy('old-record', KEY_A);
    expect(isLegacyFormat(legacy)).toBe(true);
    expect(decrypt(legacy)).toBe('old-record');
  });

  it('reads records written while no key was configured, and says so', () => {
    // These were protected only by a literal in the repository. They must remain
    // readable so the rotation script can migrate them — loudly.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const legacy = encryptLegacy('written-without-a-key', null);

    expect(decrypt(legacy)).toBe('written-without-a-key');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('old hardcoded default key'));
  });

  it('never writes the legacy format', () => {
    const fresh = encrypt('new-record');
    expect(fresh.startsWith('v2:')).toBe(true);
    expect(isLegacyFormat(fresh)).toBe(false);
  });

  it('identifies which records still need rotation', () => {
    expect(isLegacyFormat(encryptLegacy('x', KEY_A))).toBe(true);
    expect(isLegacyFormat(encrypt('x'))).toBe(false);
    expect(isLegacyFormat('plaintext')).toBe(false);
  });
});

describe('isEncrypted', () => {
  it('recognises both formats and rejects everything else', () => {
    expect(isEncrypted(encrypt('x'))).toBe(true);
    expect(isEncrypted(encryptLegacy('x', KEY_A))).toBe(true);
    expect(isEncrypted('plaintext')).toBe(false);
    expect(isEncrypted('')).toBe(false);
    expect(isEncrypted(null)).toBe(false);
    expect(isEncrypted({ a: 1 })).toBe(false);
  });
});
