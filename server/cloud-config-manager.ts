import { db } from "./db";
import { cloudAccounts } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { decrypt } from "./encryption";

export interface CloudCredentials {
  provider: 'aws' | 'gcp' | 'azure';
  accountId: string;
  accountName: string;
  credentials: any;
}

/**
 * Get all active cloud accounts from database
 */
export async function getActiveCloudAccounts(provider?: 'aws' | 'gcp' | 'azure'): Promise<CloudCredentials[]> {
  try {
    const query = provider
      ? db.select().from(cloudAccounts).where(
          and(
            eq(cloudAccounts.provider, provider),
            eq(cloudAccounts.isActive, true)
          )
        )
      : db.select().from(cloudAccounts).where(eq(cloudAccounts.isActive, true));

    const accounts = await query;
    
    console.log(`[CloudConfig] Found ${accounts.length} active ${provider || 'all'} account(s) in database`);

    return accounts.map(account => {
      const decrypted = decryptCredentials(account.credentials);
      console.log(`[CloudConfig] Decrypted credentials for ${account.provider} account: ${account.accountName}`);
      return {
        provider: account.provider as 'aws' | 'gcp' | 'azure',
        accountId: account.accountId,
        accountName: account.accountName,
        credentials: decrypted,
      };
    });
  } catch (error) {
    console.error('[CloudConfig] Error fetching cloud accounts from database:', error);
    return [];
  }
}

/**
 * Get first active account for a specific provider
 */
export async function getProviderAccount(provider: 'aws' | 'gcp' | 'azure'): Promise<CloudCredentials | null> {
  const accounts = await getActiveCloudAccounts(provider);
  return accounts.length > 0 ? accounts[0] : null;
}

/**
 * Check if a provider has any active accounts configured
 */
export async function isProviderConfigured(provider: 'aws' | 'gcp' | 'azure'): Promise<boolean> {
  const account = await getProviderAccount(provider);
  return account !== null;
}

/**
 * Decrypt credentials stored in database
 * In production, this should use proper encryption/decryption
 */
function decryptCredentials(encryptedCredentials: any): any {
  console.log(`[CloudConfig] Decrypting credentials, type: ${typeof encryptedCredentials}`);
  
  // If it's a string, it's encrypted - decrypt it
  if (typeof encryptedCredentials === 'string') {
    try {
      const decrypted = decrypt(encryptedCredentials);
      console.log(`[CloudConfig] Decrypted string length: ${decrypted.length}`);
      // Parse the decrypted JSON string back to object
      const parsed = JSON.parse(decrypted);
      console.log(`[CloudConfig] Parsed credentials keys:`, Object.keys(parsed));
      return parsed;
    } catch (error) {
      console.error('[CloudConfig] Failed to decrypt credentials:', error);
      // Try parsing as JSON directly (in case it's not encrypted)
      try {
        const parsed = JSON.parse(encryptedCredentials);
        console.log(`[CloudConfig] Parsed unencrypted credentials keys:`, Object.keys(parsed));
        return parsed;
      } catch {
        console.error('[CloudConfig] Failed to parse credentials as JSON');
        return encryptedCredentials;
      }
    }
  }
  
  // If it's already an object, check if it has encrypted flag
  if (typeof encryptedCredentials === 'object' && encryptedCredentials !== null) {
    if (encryptedCredentials._encrypted) {
      try {
        const decrypted = decrypt(encryptedCredentials.data);
        const parsed = JSON.parse(decrypted);
        console.log(`[CloudConfig] Parsed credentials with _encrypted flag keys:`, Object.keys(parsed));
        return parsed;
      } catch (error) {
        console.error('[CloudConfig] Failed to decrypt credentials with _encrypted flag:', error);
        return encryptedCredentials;
      }
    }
    // Already decrypted object
    console.log(`[CloudConfig] Credentials already an object, keys:`, Object.keys(encryptedCredentials));
    return encryptedCredentials;
  }
  
  console.log(`[CloudConfig] Returning credentials as-is`);
  return encryptedCredentials;
}

/**
 * Get credentials from database only (no environment variable fallback)
 * This ensures all users must configure their accounts through the UI
 */
export async function getProviderCredentials(provider: 'aws' | 'gcp' | 'azure'): Promise<CloudCredentials | null> {
  // Get from database only
  const dbAccount = await getProviderAccount(provider);
  
  if (!dbAccount) {
    console.log(`No ${provider.toUpperCase()} account configured in database. Please add account via Configuration page.`);
    return null;
  }

  return dbAccount;
}
