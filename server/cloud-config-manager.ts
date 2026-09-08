import { db } from "./db";
import { cloudAccounts } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { decrypt } from "./encryption";
import { currentOrgId } from "./tenant-context";

export interface CloudCredentials {
  /**
   * cloud_accounts.id — the connection this came from.
   *
   * Needed so a caller can name the specific connection when asking the AWS
   * client factory for credentials. Without it a tenant with two AWS accounts
   * could only be served "whichever one comes first", which is how the wrong
   * account gets read or mutated.
   */
  id: number;
  organizationId: number;
  provider: 'aws' | 'gcp' | 'azure';
  accountId: string;
  accountName: string;
  /** How Cloudwise authenticates: 'access_keys' (legacy) or 'assume_role'. */
  authType: string;
  credentials: any;
}

/**
 * Active cloud accounts for the current tenant.
 *
 * This function returns decrypted customer cloud credentials, which makes it the
 * single most dangerous place in the codebase to get tenancy wrong: an unscoped
 * read here hands one customer another customer's AWS keys. The tenant predicate
 * is unconditional and currentOrgId() throws when there is no context, so a
 * caller outside a request or a runAsSystem() block gets an exception rather
 * than every tenant's credentials.
 */
export async function getActiveCloudAccounts(provider?: 'aws' | 'gcp' | 'azure'): Promise<CloudCredentials[]> {
  try {
    const orgId = currentOrgId();

    const conditions = [
      eq(cloudAccounts.organizationId, orgId),
      eq(cloudAccounts.isActive, true),
    ];
    if (provider) {
      conditions.push(eq(cloudAccounts.provider, provider));
    }

    const accounts = await db.select().from(cloudAccounts).where(and(...conditions));

    console.log(`[CloudConfig] Found ${accounts.length} active ${provider || 'all'} account(s) for org ${orgId}`);

    return accounts.map(account => {
      // Role-based connections have no static credentials to decrypt, and
      // attempting it would log a spurious failure on every call. The AWS client
      // factory resolves those via STS instead.
      const decrypted = account.authType === 'access_keys'
        ? decryptCredentials(account.credentials)
        : {};

      return {
        id: account.id,
        organizationId: account.organizationId,
        provider: account.provider as 'aws' | 'gcp' | 'azure',
        accountId: account.accountId,
        accountName: account.accountName,
        authType: account.authType,
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
