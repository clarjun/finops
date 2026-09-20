/**
 * Boot-time check on the session signing key.
 *
 * Sibling of server/db-url.ts, and for the same reason: the failure it guards
 * against looks exactly like success. A server running on the development
 * placeholder starts, serves traffic and signs cookies — it just signs them
 * with a value printed in the repository, so anyone who has read the source can
 * mint a session for any user in any tenant, including an owner who can add
 * cloud credentials.
 *
 * Refusing to boot is the correct response in production. Coming up and quietly
 * accepting forged sessions is strictly worse than not coming up.
 */

/** The literal used by server/index.ts when SESSION_SECRET is unset. */
export const DEV_SESSION_SECRET = 'dev-secret-change-in-production';

/** 32 bytes of entropy, hex- or base64-encoded, is the smallest sensible key. */
const MIN_SECRET_LENGTH = 32;

export interface SessionSecretVerdict {
  ok: boolean;
  /** Present when the secret is usable but not ideal. */
  warning?: string;
  /** Present when the secret must not be used in production. */
  error?: string;
}

export function inspectSessionSecret(secret: string | undefined): SessionSecretVerdict {
  if (!secret || secret.trim() === '') {
    return { ok: false, error: 'SESSION_SECRET is not set.' };
  }
  if (secret === DEV_SESSION_SECRET) {
    return { ok: false, error: 'SESSION_SECRET is still the development placeholder.' };
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    return {
      ok: false,
      error: `SESSION_SECRET is ${secret.length} characters; at least ${MIN_SECRET_LENGTH} are required.`,
    };
  }
  // Low-entropy keys of adequate length — "aaaa…" or a passphrase — are not
  // caught by a length check. A rough uniqueness test flags the obvious cases
  // without pretending to measure entropy properly.
  if (new Set(secret).size < 8) {
    return { ok: true, warning: 'SESSION_SECRET has very few distinct characters; use random bytes rather than a phrase.' };
  }
  return { ok: true };
}

export function assertSessionSecretIsSafe(secret: string | undefined, nodeEnv: string | undefined): void {
  const verdict = inspectSessionSecret(secret);

  if (verdict.warning) {
    console.warn(`[Security] ${verdict.warning}`);
  }

  if (verdict.ok) return;

  const message =
    `${verdict.error}\n\n` +
    `Every session cookie is signed with this value. A predictable key means an ` +
    `attacker can forge a session for any user, in any tenant, without a password.\n\n` +
    `Generate one with:\n` +
    `  node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"\n` +
    `then set SESSION_SECRET=<value> in the environment.`;

  if (nodeEnv === 'production') {
    throw new Error(`[Security] ${message}`);
  }

  // Development keeps working without configuration — refusing to start a local
  // dev server over this would just get the check deleted — but the warning is
  // loud enough to be acted on before a deploy.
  console.warn(
    `\n[Security] ${verdict.error} Running in development, so this is not fatal.\n` +
    `           Production will refuse to start until SESSION_SECRET is set properly.\n`
  );
}
