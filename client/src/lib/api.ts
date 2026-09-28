/**
 * Reading an API response, including when it fails.
 *
 * This exists because of a real debugging session. The Cost Estimator showed
 * "Failed to generate estimate" while the server had returned "You have no
 * credits remaining. Add credits to continue using the API." The message that
 * named the actual problem was received by the browser and thrown away, and
 * finding it again took a probe script.
 *
 * That pattern was in thirty-odd places. Each one independently replaced the
 * server's explanation with a generic sentence, so every failure in the console
 * looked the same regardless of cause: an expired session, a missing
 * permission, a rate limit and an exhausted AI quota all rendered as "Failed
 * to load X".
 *
 * ── What this does differently ──────────────────────────────────────────────
 *
 * The server already explains itself. Handlers return { error }, { error,
 * detail }, { success: false, error } or { message }, depending on which era of
 * the codebase they come from. This reads all of those shapes and prefers the
 * server's words over anything invented here.
 *
 * Only where the server says nothing useful does it substitute a message, and
 * then it says something ACTIONABLE about the status code — "your session has
 * expired, reload" rather than "401".
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Secondary explanation, where the server sent one. */
    readonly detail?: string,
    /** Validation errors, for handlers that return a Zod issue list. */
    readonly details?: unknown,
    /** Seconds to wait, from a 429. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when retrying unchanged could plausibly work. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

/** Response bodies this codebase actually produces, across its several eras. */
interface ErrorBody {
  error?: unknown;
  detail?: unknown;
  message?: unknown;
  details?: unknown;
  retryAfterSeconds?: unknown;
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;

/**
 * What to say when the server said nothing useful.
 *
 * Every one of these is a state a user can act on, and each became reachable
 * with the security middleware: sessions expire, permissions are denied, rate
 * limits trigger. "Failed to load" for all three is useless.
 */
function fallbackMessage(status: number, what: string): string {
  switch (status) {
    case 401:
      return 'Your session has expired. Reload the page and sign in again.';
    case 403:
      return 'You do not have permission to do this.';
    case 404:
      return `${what} was not found.`;
    case 409:
      return `${what} conflicts with something that already exists.`;
    case 413:
      return 'That request was too large.';
    case 429:
      return 'Too many requests. Wait a moment and try again.';
    case 502:
    case 503:
    case 504:
      return 'The server is temporarily unavailable. Try again shortly.';
    default:
      return status >= 500
        ? `${what} failed on the server (${status}).`
        : `${what} failed (${status}).`;
  }
}

/**
 * Builds an ApiError from a failed response.
 *
 * `what` describes the operation in the caller's words — "Loading budgets",
 * "Saving the alert rule" — and is used ONLY when the server offered nothing.
 */
export async function readApiError(res: Response, what = 'The request'): Promise<ApiError> {
  let body: ErrorBody | null = null;

  try {
    const text = await res.text();
    if (text) {
      try {
        body = JSON.parse(text) as ErrorBody;
      } catch {
        // Not JSON. An HTML error page from a proxy is not worth showing a
        // user, but a short plain-text body usually is.
        const looksLikeHtml = /^\s*<|<!doctype/i.test(text);
        if (!looksLikeHtml && text.length < 300) body = { error: text };
      }
    }
  } catch {
    // Body already consumed or the stream failed; the status still tells us
    // something, so carry on rather than masking it with a parse error.
  }

  const message = str(body?.error) ?? str(body?.message) ?? str(body?.detail);
  const detail = message === str(body?.detail) ? undefined : str(body?.detail);

  return new ApiError(
    message ?? fallbackMessage(res.status, what),
    res.status,
    detail,
    body?.details,
    typeof body?.retryAfterSeconds === 'number' ? body.retryAfterSeconds : undefined,
  );
}

/** Throws a useful ApiError if the response failed. Otherwise does nothing. */
export async function throwIfFailed(res: Response, what = 'The request'): Promise<void> {
  if (!res.ok) throw await readApiError(res, what);
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  /** Serialised as JSON. Omit for a GET. */
  body?: unknown;
  /** Used only in a fallback message, when the server explains nothing. */
  what?: string;
}

/**
 * A fetch that reports failures honestly and parses the success case.
 *
 * The CSRF token and credentials are added by the wrapper installed in
 * lib/csrf.ts, so nothing here has to remember them — which is the point of
 * that wrapper existing.
 */
export async function api<T = unknown>(url: string, options: RequestOptions = {}): Promise<T> {
  const { body, what, headers, ...rest } = options;

  const res = await fetch(url, {
    ...rest,
    headers: body !== undefined
      ? { 'Content-Type': 'application/json', ...(headers ?? {}) }
      : headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: rest.credentials ?? 'include',
  });

  await throwIfFailed(res, what);

  if (res.status === 204) return undefined as T;
  return (await res.json().catch(() => undefined)) as T;
}
