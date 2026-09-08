/**
 * Envelope encryption for credentials at rest (AES-256-GCM).
 *
 * Three problems with the previous implementation, all of which this fixes:
 *
 *   1. When ENCRYPTION_KEY was unset it derived the key from a string literal
 *      in this file and merely console.warn'd. Anyone holding the repository and
 *      a database dump could decrypt every customer's cloud credentials. A key
 *      is now mandatory and a missing one is fatal, because a warning nobody
 *      reads is not a control.
 *
 *   2. The per-record salt was decorative. encrypt() generated 64 random bytes
 *      and stored them; decrypt() destructured them and never used them. Both
 *      sides derived from a hardcoded salt, so the format looked salted while
 *      every record shared one key.
 *
 *   3. There was no version marker, so rotating the key meant decrypting
 *      everything with the old one and hoping no write landed mid-flight.
 *
 * Format: v2:<salt>:<iv>:<ciphertext>:<tag>, all hex.
 * Legacy 4-part records still decrypt, so this deploys without a migration;
 * `npm run db:rotate-key` converts them.
 *
 * Key derivation is deliberately split. scrypt runs once per process to turn
 * ENCRYPTION_KEY into a master key — it is slow on purpose, which is right for a
 * passphrase and wrong per record. HKDF then derives a distinct key per record
 * from the master key and that record's salt, which is fast and is what the salt
 * was always supposed to be for.
 */
import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
/** 12 bytes is the standard GCM nonce length. */
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const VERSION = 'v2';

/** Legacy records used a 16-byte IV and this fixed derivation salt. */
const LEGACY_SCRYPT_SALT = 'azure-cost-dashboard-salt';

/**
 * The key the old code used when ENCRYPTION_KEY was unset.
 *
 * Note the derivation salt differs from LEGACY_SCRYPT_SALT: the unset path used
 * 'salt' while the configured path used 'azure-cost-dashboard-salt', so records
 * written without a key cannot be recovered by supplying that passphrase as
 * ENCRYPTION_KEY_PREVIOUS. Reproduced here so existing records can be read once
 * and re-encrypted.
 *
 * This is not a new exposure — anything it can decrypt was already protected by
 * a literal in the repository. It exists solely so `npm run db:rotate-key` can
 * migrate off it, and it is never used to encrypt.
 */
const LEGACY_DEFAULT_KEY = crypto.scryptSync('default-dev-key-change-in-production', 'salt', 32);

/** scrypt is expensive; derive each master key once per process. */
const masterKeyCache = new Map<string, Buffer>();

function deriveMasterKey(secret: string): Buffer {
  const cached = masterKeyCache.get(secret);
  if (cached) return cached;
  const key = crypto.scryptSync(secret, LEGACY_SCRYPT_SALT, KEY_LENGTH);
  masterKeyCache.set(secret, key);
  return key;
}

function requireSecret(): string {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.trim().length === 0) {
    throw new Error(
      'ENCRYPTION_KEY is not set. Credentials cannot be encrypted or decrypted without it.\n' +
      'Generate one with:  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"\n' +
      'then add ENCRYPTION_KEY=<value> to your environment.'
    );
  }
  if (key.length < 16) {
    throw new Error('ENCRYPTION_KEY is too short; use at least 32 random bytes.');
  }
  return key;
}

/**
 * The previous key, for rotation. While set, decryption falls back to it so
 * records encrypted before a rotation remain readable until re-encrypted.
 */
function previousSecret(): string | null {
  const key = process.env.ENCRYPTION_KEY_PREVIOUS;
  return key && key.trim().length > 0 ? key : null;
}

/** Per-record key: fast, and actually uses the stored salt. */
function deriveRecordKey(secret: string, salt: Buffer): Buffer {
  return Buffer.from(
    crypto.hkdfSync('sha256', deriveMasterKey(secret), salt, Buffer.from('cloudwise-credential-v2'), KEY_LENGTH)
  );
}

export function encrypt(text: string): string {
  if (!text) return '';

  const secret = requireSecret();
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = deriveRecordKey(secret, salt);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    salt.toString('hex'),
    iv.toString('hex'),
    encrypted.toString('hex'),
    tag.toString('hex'),
  ].join(':');
}

function decryptV2(parts: string[], secret: string): string {
  const [, saltHex, ivHex, encryptedHex, tagHex] = parts;
  const key = deriveRecordKey(secret, Buffer.from(saltHex, 'hex'));
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

/** Records written before versioning: fixed-salt key, 16-byte IV. */
function decryptV1WithKey(parts: string[], key: Buffer): string {
  const [, ivHex, encryptedHex, tagHex] = parts;
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  let out = decipher.update(encryptedHex, 'hex', 'utf8');
  out += decipher.final('utf8');
  return out;
}

export function decrypt(encryptedData: string): string {
  if (!encryptedData) return '';

  const parts = encryptedData.split(':');
  const isV2 = parts[0] === VERSION && parts.length === 5;
  const isV1 = parts.length === 4;

  if (!isV2 && !isV1) {
    throw new Error('Invalid encrypted data format');
  }

  // Try the current key, then the previous one, then — for legacy records only
  // — the old hardcoded default. GCM authentication means a wrong key fails
  // loudly rather than returning plausible garbage, so trying several is safe.
  const secrets = [requireSecret(), previousSecret()].filter((s): s is string => !!s);
  let lastError: unknown;

  for (const secret of secrets) {
    try {
      return isV2
        ? decryptV2(parts, secret)
        : decryptV1WithKey(parts, crypto.scryptSync(secret, LEGACY_SCRYPT_SALT, KEY_LENGTH));
    } catch (err) {
      lastError = err;
    }
  }

  if (isV1) {
    try {
      const value = decryptV1WithKey(parts, LEGACY_DEFAULT_KEY);
      console.warn(
        '[Encryption] Record decrypted with the old hardcoded default key. ' +
        'Run `npm run db:rotate-key` to re-encrypt it under ENCRYPTION_KEY.'
      );
      return value;
    } catch (err) {
      lastError = err;
    }
  }

  // Deliberately does not include the ciphertext or key material.
  throw new Error(
    `Failed to decrypt data with ${secrets.length === 1 ? 'the current key' : 'either the current or previous key'}. ` +
    `If ENCRYPTION_KEY was changed, set ENCRYPTION_KEY_PREVIOUS to the old value and run: npm run db:rotate-key. ` +
    `(${lastError instanceof Error ? lastError.message : String(lastError)})`
  );
}

/** True when a value is already ciphertext, so re-encryption can be skipped. */
export function isEncrypted(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  const parts = value.split(':');
  return (parts[0] === VERSION && parts.length === 5) || parts.length === 4;
}

/** True when a record predates versioning and should be rotated. */
export function isLegacyFormat(value: unknown): boolean {
  return typeof value === 'string' && value.split(':').length === 4;
}

/**
 * Encrypts an Azure account configuration object
 * Encrypts sensitive fields: tenantId, clientId, clientSecret
 */
export function encryptAzureConfig(config: any): any {
  return {
    ...config,
    tenantId: encrypt(config.tenantId),
    clientId: encrypt(config.clientId),
    clientSecret: encrypt(config.clientSecret),
  };
}

/**
 * Decrypts an Azure account configuration object
 * Decrypts sensitive fields: tenantId, clientId, clientSecret
 */
export function decryptAzureConfig(config: any): any {
  return {
    ...config,
    tenantId: decrypt(config.tenantId),
    clientId: decrypt(config.clientId),
    clientSecret: decrypt(config.clientSecret),
  };
}
