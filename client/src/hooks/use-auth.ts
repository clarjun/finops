import { useMsal } from "@azure/msal-react";

export function useAuth() {
  const { instance, accounts } = useMsal();
  const account = instance.getActiveAccount() || accounts[0];

  return {
    isAuthenticated: !!account,
    user: account
      ? { id: 1, name: account.name, email: account.username }
      : undefined,
    isLoading: false,
  };
}
