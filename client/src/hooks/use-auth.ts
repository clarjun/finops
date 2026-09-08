import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

/** Mirrors server/rbac.ts. Keep the two in sync. */
export const USER_ROLES = ['viewer', 'engineer', 'finops', 'admin', 'owner'] as const;
export type UserRole = typeof USER_ROLES[number];

export type Permission =
  | 'cost:read' | 'export:read'
  | 'budget:write' | 'report:write'
  | 'account:read' | 'account:write'
  | 'agent:propose' | 'agent:approve' | 'agent:execute' | 'agent:configure'
  | 'user:manage' | 'org:manage' | 'audit:read';

export const ROLE_LABELS: Record<UserRole, string> = {
  viewer: 'Viewer',
  engineer: 'Engineer',
  finops: 'FinOps',
  admin: 'Admin',
  owner: 'Owner',
};

export const ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  viewer: 'Read dashboards, reports and cost data',
  engineer: 'Viewer, plus exports and proposing optimizations',
  finops: 'Engineer, plus budgets, schedules and approving actions',
  admin: 'FinOps, plus cloud credentials, executing actions and user management',
  owner: 'Full control including organization settings',
};

export interface AuthOrganization {
  id: number;
  name: string;
  slug: string;
  plan: string;
}

export interface AuthUser {
  id: number;
  organizationId: number;
  username: string;
  email: string | null;
  fullName: string | null;
  role: UserRole;
  isPlatformAdmin: boolean;
  isActive: boolean;
  activeOrganizationId?: number;
  organization?: AuthOrganization | null;
  /** Authoritative list from the server — never inferred from the role here. */
  permissions?: Permission[];
}

export function useAuth() {
  const { data: user, isLoading } = useQuery<AuthUser | null>({
    queryKey: ['/api/auth/me'],
    queryFn: async () => {
      const res = await fetch('/api/auth/me', { credentials: 'include' });
      if (res.status === 401) return null;
      return res.json();
    },
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  // Permissions come from the server rather than being recomputed from the role
  // on the client, so the two can never disagree about what a role grants.
  // This only controls what the UI offers — the API enforces it independently.
  const can = (permission: Permission) => user?.permissions?.includes(permission) ?? false;

  return {
    isAuthenticated: !!user,
    user,
    isLoading,
    can,
    role: user?.role,
    organization: user?.organization ?? null,
    isPlatformAdmin: user?.isPlatformAdmin ?? false,
    /** Retained for existing call sites: "can reach admin-only screens". */
    isAdmin: can('user:manage'),
  };
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ username, password }: { username: string; password: string }) => {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['/api/auth/me'] }),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    },
    onSuccess: () => {
      qc.clear();
      window.location.href = '/login';
    },
  });
}
