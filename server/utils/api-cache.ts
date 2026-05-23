/**
 * API Response Cache with Rate Limiting
 * Prevents hitting cloud provider rate limits by caching responses
 */

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  expiresAt: number;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

class APICache {
  private cache: Map<string, CacheEntry<any>> = new Map();
  private rateLimits: Map<string, RateLimitEntry> = new Map();
  
  // Default cache duration: 2 minutes
  private defaultTTL = 2 * 60 * 1000;
  
  // Rate limit: max 10 requests per minute per provider
  private maxRequestsPerMinute = 10;
  private rateLimitWindow = 60 * 1000; // 1 minute

  /**
   * Get cached data if available and not expired
   */
  get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    
    if (!entry) {
      return null;
    }
    
    // Check if expired
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    
    console.log(`[Cache] HIT: ${key} (age: ${Math.round((Date.now() - entry.timestamp) / 1000)}s)`);
    return entry.data as T;
  }

  /**
   * Set cache data with optional TTL
   */
  set<T>(key: string, data: T, ttl?: number): void {
    const now = Date.now();
    const expiresAt = now + (ttl || this.defaultTTL);
    
    this.cache.set(key, {
      data,
      timestamp: now,
      expiresAt,
    });
    
    console.log(`[Cache] SET: ${key} (TTL: ${Math.round((ttl || this.defaultTTL) / 1000)}s)`);
  }

  /**
   * Check if rate limit allows request
   */
  canMakeRequest(provider: string): boolean {
    const key = `ratelimit:${provider}`;
    const limit = this.rateLimits.get(key);
    const now = Date.now();
    
    // No limit entry or window expired - allow request
    if (!limit || now > limit.resetAt) {
      this.rateLimits.set(key, {
        count: 1,
        resetAt: now + this.rateLimitWindow,
      });
      return true;
    }
    
    // Check if under limit
    if (limit.count < this.maxRequestsPerMinute) {
      limit.count++;
      return true;
    }
    
    // Rate limit exceeded
    const waitTime = Math.ceil((limit.resetAt - now) / 1000);
    console.log(`[RateLimit] ${provider} rate limit exceeded. Wait ${waitTime}s`);
    return false;
  }

  /**
   * Clear all cache entries
   */
  clear(): void {
    this.cache.clear();
    console.log('[Cache] Cleared all entries');
  }

  /**
   * Clear cache for specific provider
   */
  clearProvider(provider: string): void {
    const keysToDelete: string[] = [];
    
    for (const key of this.cache.keys()) {
      if (key.includes(provider)) {
        keysToDelete.push(key);
      }
    }
    
    keysToDelete.forEach(key => this.cache.delete(key));
    console.log(`[Cache] Cleared ${keysToDelete.length} entries for ${provider}`);
  }

  /**
   * Get cache statistics
   */
  getStats() {
    const now = Date.now();
    let validEntries = 0;
    let expiredEntries = 0;
    
    for (const entry of this.cache.values()) {
      if (now > entry.expiresAt) {
        expiredEntries++;
      } else {
        validEntries++;
      }
    }
    
    return {
      total: this.cache.size,
      valid: validEntries,
      expired: expiredEntries,
      rateLimits: this.rateLimits.size,
    };
  }

  /**
   * Clean up expired entries
   */
  cleanup(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];
    
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        keysToDelete.push(key);
      }
    }
    
    keysToDelete.forEach(key => this.cache.delete(key));
    
    if (keysToDelete.length > 0) {
      console.log(`[Cache] Cleaned up ${keysToDelete.length} expired entries`);
    }
  }
}

// Singleton instance
export const apiCache = new APICache();

// Run cleanup every 5 minutes
setInterval(() => {
  apiCache.cleanup();
}, 5 * 60 * 1000);

/**
 * Helper to create cache key for cost data
 */
export function createCostCacheKey(
  provider: string,
  startDate: string,
  endDate: string,
  serviceName?: string,
  accountId?: string
): string {
  const parts = [provider, startDate, endDate];
  if (serviceName) parts.push(serviceName);
  if (accountId) parts.push(accountId);
  return `cost:${parts.join(':')}`;
}

/**
 * Wrapper for API calls with caching and rate limiting
 */
export async function cachedAPICall<T>(
  cacheKey: string,
  provider: string,
  apiCall: () => Promise<T>,
  ttl?: number
): Promise<T> {
  // Check cache first
  const cached = apiCache.get<T>(cacheKey);
  if (cached !== null) {
    return cached;
  }
  
  // Check rate limit
  if (!apiCache.canMakeRequest(provider)) {
    // Return cached data even if expired, or throw error
    const expiredCache = apiCache.get<T>(cacheKey);
    if (expiredCache !== null) {
      console.log(`[Cache] Returning expired cache due to rate limit: ${cacheKey}`);
      return expiredCache;
    }
    
    throw new Error(`Rate limit exceeded for ${provider}. Please try again in a moment.`);
  }
  
  // Make API call
  console.log(`[Cache] MISS: ${cacheKey} - Making API call`);
  const data = await apiCall();
  
  // Cache the result
  apiCache.set(cacheKey, data, ttl);
  
  return data;
}
