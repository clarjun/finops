/**
 * Ambient tenant context.
 *
 * Roughly thirty modules in this codebase reach the database without ever
 * seeing a Request — schedulers, analyzers, the cost fetchers, the agent
 * executor. Threading an organizationId parameter through all of them would
 * touch every call site and would silently regress the moment someone forgets
 * one. AsyncLocalStorage carries the tenant down the async call tree instead,
 * so `storage.getActiveBudgets()` resolves the right tenant no matter how deep
 * it is called from.
 *
 * Two entry points establish context:
 *   - HTTP requests, via withTenantContext() in server/middleware/auth-guard.ts
 *   - background jobs, via runAsSystem() which must name its tenant explicitly
 *
 * Anything reaching the database outside both is a bug, and currentOrgId()
 * throws rather than guessing.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { UserRole } from "@shared/schema";

export interface TenantContext {
  organizationId: number;
  /** Absent for background jobs, which act as the system rather than a user. */
  userId?: number;
  username?: string;
  role?: UserRole;
  isPlatformAdmin?: boolean;
  /** True when a background job established the context. */
  isSystem?: boolean;
  requestId?: string;
}

const storage = new AsyncLocalStorage<TenantContext>();

export function runWithTenant<T>(ctx: TenantContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * Establish context for a background job. Jobs must name the tenant they are
 * acting for — there is no ambient default — which is what forces schedulers to
 * iterate organizations instead of quietly operating on whatever org happens to
 * be id 1.
 */
export function runAsSystem<T>(organizationId: number, fn: () => T): T {
  return storage.run({ organizationId, isSystem: true }, fn);
}

export function getTenantContext(): TenantContext | undefined {
  return storage.getStore();
}

/**
 * The tenant for the current unit of work. Throws when there is none: a query
 * that cannot name its tenant must fail loudly rather than read across all of
 * them.
 */
export function currentOrgId(): number {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error(
      "No tenant context. Database access must happen inside an authenticated " +
        "request or inside runAsSystem(orgId, ...). See server/tenant-context.ts."
    );
  }
  return ctx.organizationId;
}

/** Same as currentOrgId() but returns null instead of throwing. */
export function currentOrgIdOrNull(): number | null {
  return storage.getStore()?.organizationId ?? null;
}

export function currentUserId(): number | undefined {
  return storage.getStore()?.userId;
}

export function currentUsername(): string | undefined {
  return storage.getStore()?.username;
}
