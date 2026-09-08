/**
 * The password policy, in one place.
 *
 * It was previously written out at four separate call sites — twice in
 * server/auth.ts, once in the users page, and not at all in the seeding script,
 * which is exactly the one that could create an account the application's own
 * UI would then refuse to accept. Rules that are restated rather than shared
 * drift, and they drift silently.
 *
 * Length over composition. Requiring a symbol and a digit pushes people toward
 * "Password1!" and is no longer recommended (NIST SP 800-63B); a longer
 * passphrase is both stronger and easier to remember. So this checks length and
 * screens obviously-guessable values, and nothing else.
 */

/** Minimum characters. Not the same number as BCRYPT_ROUNDS, despite appearances. */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * bcrypt cost factor. Distinct from MIN_PASSWORD_LENGTH — both happened to be
 * 12 in the original code, which made every call site ambiguous at a glance.
 */
export const BCRYPT_ROUNDS = 12;

/**
 * Upper bound. bcrypt silently truncates input beyond 72 bytes, so a longer
 * password is not more secure and, worse, two different long passwords sharing
 * a prefix would both authenticate. Rejecting is honest; truncating is not.
 */
export const MAX_PASSWORD_LENGTH = 72;

/**
 * Values common enough that length alone does not help. Deliberately short:
 * this is a sanity screen, not a substitute for a breach-corpus check, and
 * pretending otherwise would be worse than the honest small list.
 */
const OBVIOUSLY_GUESSABLE = [
  'password', 'passw0rd', 'letmein', 'welcome', 'changeme', 'admin',
  'qwerty', '123456', 'iloveyou', 'monkey', 'dragon', 'football',
];

export interface PasswordValidation {
  valid: boolean;
  error?: string;
}

export function validatePassword(password: unknown): PasswordValidation {
  if (typeof password !== 'string') {
    return { valid: false, error: 'Password must be a string' };
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    return { valid: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }

  // Measured in bytes, not characters: a multi-byte passphrase can pass a
  // length check and still exceed bcrypt's limit.
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_LENGTH) {
    return { valid: false, error: `Password must be at most ${MAX_PASSWORD_LENGTH} bytes` };
  }

  if (password.trim().length === 0) {
    return { valid: false, error: 'Password cannot be only whitespace' };
  }

  const normalized = password.toLowerCase();
  if (OBVIOUSLY_GUESSABLE.some(w => normalized.includes(w))) {
    return { valid: false, error: 'Password contains a commonly guessed word' };
  }

  // A long run of one character passes a length check while carrying almost no
  // entropy — "aaaaaaaaaaaa" is twelve characters and worthless.
  if (/^(.)\1+$/.test(password)) {
    return { valid: false, error: 'Password cannot be a single repeated character' };
  }

  return { valid: true };
}
