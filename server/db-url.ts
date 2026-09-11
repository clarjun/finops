/**
 * Connection-string checks that run before the pool opens.
 *
 * Azure Database for PostgreSQL requires TLS, and node-postgres does NOT enable
 * it unless the URL says so. Verified against pg-connection-string 2.7.0:
 *
 *   (no sslmode)         -> ssl = undefined          plaintext
 *   ?sslmode=require     -> ssl = {}                 TLS, cert + host verified
 *   ?sslmode=no-verify   -> ssl = {rejectUnauthorized:false}   TLS, unverified
 *   ?sslmode=disable     -> ssl = false              plaintext
 *
 * So a production URL missing `?sslmode=require` either fails with Azure's
 * opaque "SSL connection is required" or — against a server that permits
 * plaintext — silently sends the database password and every row in the clear.
 * That second outcome is the one worth failing the boot over: it looks like it
 * works.
 *
 * Local development over plaintext to localhost is left alone; the traffic never
 * leaves the machine.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export interface DbUrlVerdict {
  host: string;
  isLocal: boolean;
  sslmode: string | null;
  /** True when credentials would cross a network unencrypted. */
  insecure: boolean;
  /** Present when TLS is on but the certificate is not being checked. */
  warning?: string;
}

export function inspectDatabaseUrl(url: string): DbUrlVerdict {
  const parsed = new URL(url);
  const host = parsed.hostname;
  const isLocal = LOCAL_HOSTS.has(host);
  const sslmode = parsed.searchParams.get('sslmode');

  const plaintext = sslmode === null || sslmode === 'disable';

  return {
    host,
    isLocal,
    sslmode,
    insecure: plaintext && !isLocal,
    warning: sslmode === 'no-verify' && !isLocal
      ? 'sslmode=no-verify encrypts the connection but does not verify the server certificate, ' +
        'so it cannot detect an impostor. Azure\'s certificate chains to a root Node already ' +
        'trusts — use sslmode=require instead.'
      : undefined,
  };
}

/**
 * Throws when the configured database would be reached insecurely.
 *
 * Called once at startup. Refusing to boot is the right response: a server that
 * comes up and quietly leaks credentials is worse than one that does not come up.
 */
export function assertDatabaseUrlIsSafe(url: string | undefined): void {
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. The application has no database to connect to.\n' +
      'Local:      postgresql://postgres:<password>@localhost:5432/cloud_cost_agent\n' +
      'Azure:      postgresql://<user>:<password>@<server>.postgres.database.azure.com:5432/<db>?sslmode=require'
    );
  }

  let verdict: DbUrlVerdict;
  try {
    verdict = inspectDatabaseUrl(url);
  } catch {
    throw new Error('DATABASE_URL is not a valid connection URL.');
  }

  if (verdict.insecure) {
    throw new Error(
      `DATABASE_URL points at the remote host "${verdict.host}" without TLS ` +
      `(sslmode=${verdict.sslmode ?? 'unset'}).\n` +
      'The database password and every row would cross the network in plaintext.\n' +
      `Append ?sslmode=require to the URL. Azure Database for PostgreSQL requires it, ` +
      'and its certificate chains to a root Node already trusts, so nothing else is needed.'
    );
  }

  if (verdict.warning) {
    console.warn(`[db] ${verdict.warning}`);
  }

  console.log(
    `[db] ${verdict.host} (${verdict.isLocal ? 'local' : 'remote'}, ` +
    `sslmode=${verdict.sslmode ?? 'none'})`,
  );
}
