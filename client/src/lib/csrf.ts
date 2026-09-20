/**
 * Attaches the CSRF token to every state-changing request the console makes.
 *
 * Done by wrapping window.fetch once, rather than by editing forty-odd call
 * sites. That is not laziness: a header that has to be remembered at each call
 * site is a header that will be forgotten at the next one, and the failure mode
 * is a 403 in production on a feature that worked in review. Wrapping fetch
 * makes the protection impossible to opt out of by accident.
 *
 * The token itself is issued by the server in a readable XSRF-TOKEN cookie —
 * readable on purpose, because same-origin policy is what stops another site
 * from reading it and therefore from forging the header.
 */

const CSRF_COOKIE = 'XSRF-TOKEN';
const CSRF_HEADER = 'X-CSRF-Token';
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function readToken(): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${CSRF_COOKIE}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

/** Same-origin only. A request to a third party must never carry our token. */
function isSameOrigin(input: RequestInfo | URL): boolean {
  try {
    const url =
      typeof input === 'string' ? new URL(input, window.location.href)
      : input instanceof URL ? input
      : new URL(input.url, window.location.href);
    return url.origin === window.location.origin;
  } catch {
    // A relative path that failed to parse is still same-origin by definition.
    return true;
  }
}

export function installCsrfFetch(): void {
  const original = window.fetch.bind(window);

  window.fetch = function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

    if (!MUTATING.has(method) || !isSameOrigin(input)) {
      return original(input, init);
    }

    const token = readToken();
    if (!token) return original(input, init);

    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    // Never overwrite a header a caller set deliberately.
    if (!headers.has(CSRF_HEADER)) headers.set(CSRF_HEADER, token);

    // credentials: 'include' is set here as well as at the call sites. The
    // token is worthless without the session cookie travelling with it, and a
    // call site that forgot one of the two is the exact bug this wrapper exists
    // to make impossible.
    return original(input, { ...init, headers, credentials: init?.credentials ?? 'include' });
  };
}
