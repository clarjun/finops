/**
 * Run database migration to add notification fields to budgets table
 */

require('dotenv').config(); // Load environment variables
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function runMigration() {
  const connectionString = process.env.DATABASE_URL;
  
  if (!connectionString) {
    console.error('ERROR: DATABASE_URL environment variable is not set');
    console.error('Please check your .env file');
    process.exit(1);
  }

  console.log('Connecting to database...');
  
  const client = new Client({
    connectionString: connectionString
  });

  try {
    await client.connect();
    console.log('✓ Connected to database');

    // Read migration file
    const migrationPath = path.join(__dirname, 'db', 'migrations', '0003_add_budget_notifications.sql');
    const migrationSQL = fs.readFileSync(migrationPath, 'utf8');

    console.log('\nRunning migration: 0003_add_budget_notifications.sql');
    console.log('---------------------------------------------------');
    
    // Execute migration
    await client.query(migrationSQL);
    
    console.log('\n✓ Migration completed successfully!');
    console.log('\nAdded columns to budgets table:');
    console.log('  ✓ email_recipients (TEXT)');
    console.log('  ✓ webhook_url (TEXT)');
    console.log('  ✓ last_alerted_at (TIMESTAMP)');
    console.log('  ✓ last_alerted_threshold (INTEGER)');
    console.log('\nBudgets can now send email and webhook notifications directly!');

  } catch (error) {
    console.error('\n✗ Migration failed:', error.message);
    console.error('\nFull error:', error);
    process.exit(1);
  } finally {
    await client.end();
    console.log('\nDatabase connection closed.');
  }
}

runMigration();
