/**
 * Persistent File-Based Cache
 * Survives server restarts by storing cache on disk
 */

import fs from 'fs';
import path from 'path';

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  expiresAt: number;
}

class PersistentCache {
  private cacheDir: string;
  private memoryCache: Map<string, CacheEntry<any>> = new Map();
  
  constructor() {
    // Store cache in .local/cache directory
    this.cacheDir = path.join(process.cwd(), '.local', 'cache');
    this.ensureCacheDir();
    this.loadCacheFromDisk();
  }

  private ensureCacheDir() {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  private getCacheFilePath(key: string): string {
    // Create safe filename from key
    const safeKey = Buffer.from(key).toString('base64').replace(/[/+=]/g, '_');
    return path.join(this.cacheDir, `${safeKey}.json`);
  }

  private loadCacheFromDisk() {
    try {
      const files = fs.readdirSync(this.cacheDir);
      let loaded = 0;
      let expired = 0;
      
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        
        try {
          const filePath = path.join(this.cacheDir, file);
          const content = fs.readFileSync(filePath, 'utf-8');
          const entry: CacheEntry<any> & { key: string } = JSON.parse(content);
          
          // Check if expired
          if (Date.now() > entry.expiresAt) {
            fs.unlinkSync(filePath);
            expired++;
          } else {
            this.memoryCache.set(entry.key, {
              data: entry.data,
              timestamp: entry.timestamp,
              expiresAt: entry.expiresAt,
            });
            loaded++;
          }
        } catch (err) {
          // Skip corrupted files
          console.error(`[PersistentCache] Error loading ${file}:`, err);
        }
      }
      
      if (loaded > 0 || expired > 0) {
        console.log(`[PersistentCache] Loaded ${loaded} entries, removed ${expired} expired`);
      }
    } catch (err) {
      console.error('[PersistentCache] Error loading cache from disk:', err);
    }
  }

  /**
   * Get cached data if available and not expired
   */
  get<T>(key: string): T | null {
    const entry = this.memoryCache.get(key);
    
    if (!entry) {
      return null;
    }
    
    // Check if expired
    if (Date.now() > entry.expiresAt) {
      this.delete(key);
      return null;
    }
    
    const age = Math.round((Date.now() - entry.timestamp) / 1000);
    console.log(`[PersistentCache] HIT: ${key} (age: ${age}s)`);
    return entry.data as T;
  }

  /**
   * Get the timestamp (ms) when a key was last set — returns null if not in cache
   */
  getTimestamp(key: string): number | null {
    const entry = this.memoryCache.get(key);
    if (!entry || Date.now() > entry.expiresAt) return null;
    return entry.timestamp;
  }

  /**
   * Set cache data with optional TTL
   */
  set<T>(key: string, data: T, ttl: number = 60 * 60 * 1000): void {
    const now = Date.now();
    const expiresAt = now + ttl;
    
    const entry: CacheEntry<T> = {
      data,
      timestamp: now,
      expiresAt,
    };
    
    // Store in memory
    this.memoryCache.set(key, entry);
    
    // Persist to disk
    try {
      const filePath = this.getCacheFilePath(key);
      const fileContent = JSON.stringify({
        key,
        ...entry,
      }, null, 2);
      
      fs.writeFileSync(filePath, fileContent, 'utf-8');
      console.log(`[PersistentCache] SET: ${key} (TTL: ${Math.round(ttl / 1000)}s)`);
    } catch (err) {
      console.error(`[PersistentCache] Error writing cache for ${key}:`, err);
    }
  }

  /**
   * Delete a cache entry
   */
  delete(key: string): void {
    this.memoryCache.delete(key);
    
    try {
      const filePath = this.getCacheFilePath(key);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (err) {
      console.error(`[PersistentCache] Error deleting cache for ${key}:`, err);
    }
  }

  /**
   * Clear all cache entries
   */
  clear(): void {
    this.memoryCache.clear();
    
    try {
      const files = fs.readdirSync(this.cacheDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          fs.unlinkSync(path.join(this.cacheDir, file));
        }
      }
      console.log('[PersistentCache] Cleared all entries');
    } catch (err) {
      console.error('[PersistentCache] Error clearing cache:', err);
    }
  }

  /**
   * Clear cache for specific provider
   */
  clearProvider(provider: string): void {
    const keysToDelete: string[] = [];
    
    for (const key of this.memoryCache.keys()) {
      if (key.includes(provider)) {
        keysToDelete.push(key);
      }
    }
    
    keysToDelete.forEach(key => this.delete(key));
    console.log(`[PersistentCache] Cleared ${keysToDelete.length} entries for ${provider}`);
  }

  /**
   * Get cache statistics
   */
  getStats() {
    const now = Date.now();
    let validEntries = 0;
    let expiredEntries = 0;
    
    for (const entry of this.memoryCache.values()) {
      if (now > entry.expiresAt) {
        expiredEntries++;
      } else {
        validEntries++;
      }
    }
    
    return {
      total: this.memoryCache.size,
      valid: validEntries,
      expired: expiredEntries,
    };
  }

  /**
   * Clean up expired entries
   */
  cleanup(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];
    
    for (const [key, entry] of this.memoryCache.entries()) {
      if (now > entry.expiresAt) {
        keysToDelete.push(key);
      }
    }
    
    keysToDelete.forEach(key => this.delete(key));
    
    if (keysToDelete.length > 0) {
      console.log(`[PersistentCache] Cleaned up ${keysToDelete.length} expired entries`);
    }
  }
}

// Singleton instance
export const persistentCache = new PersistentCache();

// Run cleanup every 10 minutes
setInterval(() => {
  persistentCache.cleanup();
}, 10 * 60 * 1000);
