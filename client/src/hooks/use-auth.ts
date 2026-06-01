import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export interface AuthUser {
  id: number;
  username: string;
  role: 'admin' | 'user';
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

  return {
    isAuthenticated: !!user,
    user,
    isLoading,
    isAdmin: user?.role === 'admin',
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
