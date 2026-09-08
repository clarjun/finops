// import { drizzle } from 'drizzle-orm/neon-serverless';
// import { Pool, neonConfig } from '@neondatabase/serverless';
// import * as schema from '@shared/schema';
// import ws from 'ws';

// // Configure WebSocket for Neon serverless
// neonConfig.webSocketConstructor = ws;

// // Create connection pool
// const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// // Create drizzle instance with schema
// export const db = drizzle(pool, { schema });


import { drizzle } from 'drizzle-orm/node-postgres';
import pkg from 'pg';
import * as schema from '@shared/schema';

const { Pool } = pkg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Bounded so several Container Apps replicas cannot exhaust the server's
  // connection limit between them. Postgres counts connections per server, not
  // per process, and the default (10 per pool) times N replicas overruns a
  // small instance quickly.
  max: Number(process.env.PGPOOL_MAX) || 10,
  // Recycle idle connections before the server or any intermediary drops them.
  // A connection killed while idle is the usual source of `read ECONNRESET`.
  idleTimeoutMillis: 30_000,
  // Fail a connection attempt rather than hanging a request forever.
  connectionTimeoutMillis: 10_000,
});

/**
 * Idle-client failures must not kill the process.
 *
 * node-postgres emits 'error' on the pool when a client that is sitting idle
 * dies — a database restart, an idle timeout on the server side, a network
 * blip. `error` is a special event: an EventEmitter with no listener for it
 * THROWS, so a transient connection reset became an uncaught exception and took
 * the whole server down with it.
 *
 * Logging is the correct response. The pool discards the dead client and the
 * next caller gets a fresh one, so there is nothing to recover — only something
 * to record.
 */
pool.on('error', (err) => {
  console.error('[db] idle client error (pool will recover):', err.message);
});

export const db = drizzle(pool, { schema });