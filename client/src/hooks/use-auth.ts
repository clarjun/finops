import { useQuery } from "@tanstack/react-query";

export interface AuthUser {
  id: number;
  name: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
}

export interface AuthStatus {
  authenticated: boolean;
  configured: boolean;
  user?: AuthUser;
}

export function useAuth() {
  const {data, isLoading, refetch} = useQuery<AuthStatus>({
    queryKey: ['/auth/status'],
    retry: false,
  });

  return {
    isAuthenticated: data?.authenticated ?? false,
    isConfigured: data?.configured ?? false,
    user: data?.user,
    isLoading,
    refetch,
  };
}
