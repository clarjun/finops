import { QueryClient, QueryFunction } from "@tanstack/react-query";
import { throwIfFailed } from "./api";

// Routed through lib/api so a failure reads as "Your session has expired" or
// the server's own sentence, rather than `500: {"error":"..."}` with the raw
// JSON shown to a user.

export async function apiRequest<T = any>(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });

  await throwIfFailed(res, `${method} ${url}`);
  return await res.json();
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(queryKey.join("/") as string, {
      credentials: "include",
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    // Check the status BEFORE parsing. Parsing first meant a non-JSON error
    // body — an HTML page from a proxy, an empty 502 — threw a parse error that
    // replaced the real status, so the actual failure was never reported.
    await throwIfFailed(res, String(queryKey[0] ?? 'The request'));

    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
