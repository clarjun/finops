require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  
  // Create users table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(100) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'user',
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_by INTEGER,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  console.log('Users table created');

  // Generate hash for ClAdmin$07
  const hash = await bcrypt.hash('ClAdmin$07', 10);
  
  await pool.query(`
    INSERT INTO users (username, password_hash, role)
    VALUES ('admin', $1, 'admin')
    ON CONFLICT (username) DO UPDATE SET password_hash = $1, role = 'admin'
  `, [hash]);
  
  console.log('Admin user seeded: username=admin, password=ClAdmin$07');
  pool.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
