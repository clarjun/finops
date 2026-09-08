import { describe, it, expect } from 'vitest';
import {
  validatePassword, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH, BCRYPT_ROUNDS,
} from './password-policy';

describe('password policy', () => {
  it('accepts a reasonable passphrase', () => {
    expect(validatePassword('correct horse battery staple').valid).toBe(true);
    expect(validatePassword('ona6p7A1FjuJyUJU8Yb9jarf').valid).toBe(true);
  });

  it('rejects anything shorter than the minimum', () => {
    const result = validatePassword('short');
    expect(result.valid).toBe(false);
    expect(result.error).toContain(String(MIN_PASSWORD_LENGTH));
  });

  it('rejects the legacy seeded password, which is why this policy exists', () => {
    // 'ClAdmin$07' is 10 characters. The seeding script had no length check, so
    // it could create an account the user-management screen would then refuse.
    expect(validatePassword('ClAdmin$07').valid).toBe(false);
  });

  it('treats the boundary as inclusive', () => {
    expect(validatePassword('a'.repeat(MIN_PASSWORD_LENGTH - 1)).valid).toBe(false);
    // Exactly at the minimum but a single repeated character — caught by the
    // entropy check rather than the length check.
    expect(validatePassword('a'.repeat(MIN_PASSWORD_LENGTH)).valid).toBe(false);
    expect(validatePassword(`ab${'cd'.repeat(5)}`).valid).toBe(true);
  });

  it('rejects passwords longer than bcrypt will actually read', () => {
    // bcrypt silently truncates past 72 bytes. Two long passwords sharing a
    // prefix would both authenticate, so accepting them would be a lie.
    const tooLong = 'x1y2z3'.repeat(20);          // 120 chars
    expect(tooLong.length).toBeGreaterThan(MAX_PASSWORD_LENGTH);
    expect(validatePassword(tooLong).valid).toBe(false);
  });

  it('measures the maximum in bytes, not characters', () => {
    // 25 emoji is 50 UTF-16 units but 100 bytes. A .length-based check would
    // wave this through and bcrypt would silently truncate it past 72 bytes.
    const multibyte = '🔐'.repeat(25);
    expect(multibyte.length).toBeLessThan(MAX_PASSWORD_LENGTH);
    expect(Buffer.byteLength(multibyte, 'utf8')).toBeGreaterThan(MAX_PASSWORD_LENGTH);
    expect(validatePassword(multibyte).valid).toBe(false);
  });

  it('rejects obviously guessable values even when long enough', () => {
    for (const p of ['passwordpassword', 'letmein12345', 'Welcome123456', 'admin1234567']) {
      expect(validatePassword(p).valid, p).toBe(false);
    }
  });

  it('rejects whitespace-only input', () => {
    expect(validatePassword('              ').valid).toBe(false);
  });

  it('rejects non-strings rather than throwing', () => {
    for (const v of [undefined, null, 12345678901234, {}, []]) {
      const result = validatePassword(v);
      expect(result.valid).toBe(false);
      expect(result.error).toBeTruthy();
    }
  });

  it('always explains why it rejected', () => {
    for (const p of ['short', 'passwordpassword', '            ', 'a'.repeat(200)]) {
      expect(validatePassword(p).error, p).toBeTruthy();
    }
  });

  it('keeps the bcrypt cost factor distinct from the length minimum', () => {
    // Both were literal 12s at four call sites, which made every use ambiguous.
    // They are separate constants now even though the values coincide today.
    expect(BCRYPT_ROUNDS).toBeGreaterThanOrEqual(10);
    expect(MIN_PASSWORD_LENGTH).toBeGreaterThanOrEqual(12);
  });
});
