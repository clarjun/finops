import crypto from 'crypto';

// Encryption utility for sensitive data
// Uses AES-256-GCM for authenticated encryption

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 64;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

// Get encryption key from environment or generate a secure default
// IMPORTANT: In production, this MUST be set via environment variable
function getEncryptionKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    console.warn('WARNING: ENCRYPTION_KEY not set. Using default key. SET THIS IN PRODUCTION!');
    // Default key for development only - NEVER use in production
    return crypto.scryptSync('default-dev-key-change-in-production', 'salt', KEY_LENGTH);
  }
  
  // Derive a proper encryption key from the provided key
  return crypto.scryptSync(key, 'azure-cost-dashboard-salt', KEY_LENGTH);
}

/**
 * Encrypts sensitive text data
 * @param text - Plain text to encrypt
 * @returns Encrypted data in format: salt:iv:encrypted:tag (all hex-encoded)
 */
export function encrypt(text: string): string {
  if (!text) return '';
  
  try {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const tag = cipher.getAuthTag();
    
    // Return format: salt:iv:encrypted:tag (all hex)
    return `${salt.toString('hex')}:${iv.toString('hex')}:${encrypted}:${tag.toString('hex')}`;
  } catch (error) {
    console.error('Encryption error:', error);
    throw new Error('Failed to encrypt data');
  }
}

/**
 * Decrypts encrypted data
 * @param encryptedData - Encrypted string in format: salt:iv:encrypted:tag
 * @returns Decrypted plain text
 */
export function decrypt(encryptedData: string): string {
  if (!encryptedData) return '';
  
  try {
    const parts = encryptedData.split(':');
    if (parts.length !== 4) {
      throw new Error('Invalid encrypted data format');
    }
    
    const [saltHex, ivHex, encryptedHex, tagHex] = parts;
    
    const key = getEncryptionKey();
    const iv = Buffer.from(ivHex, 'hex');
    const encrypted = encryptedHex;
    const tag = Buffer.from(tagHex, 'hex');
    
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    console.error('Decryption error:', error);
    throw new Error('Failed to decrypt data');
  }
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
