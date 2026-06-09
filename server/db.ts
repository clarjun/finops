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
});

export const db = drizzle(pool, { schema });