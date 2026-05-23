// Test script to check cloud accounts in database
const { Pool } = require('pg');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('DATABASE_URL not found in environment');
  process.exit(1);
}

const pool = new Pool({ connectionString });

async function testDatabaseAccounts() {
  try {
    console.log('🔍 Checking cloud accounts in database...\n');
    
    const result = await pool.query(`
      SELECT id, provider, account_name, account_id, is_active, created_at
      FROM cloud_accounts
      ORDER BY created_at DESC
    `);
    
    if (result.rows.length === 0) {
      console.log('❌ No cloud accounts found in database');
      console.log('\n💡 Please add accounts via the Configuration page in the UI');
    } else {
      console.log(`✅ Found ${result.rows.length} cloud account(s):\n`);
      
      result.rows.forEach((account, index) => {
        console.log(`${index + 1}. ${account.provider.toUpperCase()}`);
        console.log(`   Name: ${account.account_name}`);
        console.log(`   Account ID: ${account.account_id}`);
        console.log(`   Active: ${account.is_active ? 'Yes' : 'No'}`);
        console.log(`   Created: ${account.created_at}`);
        console.log('');
      });
    }
    
    await pool.end();
  } catch (error) {
    console.error('Error checking database:', error);
    process.exit(1);
  }
}

testDatabaseAccounts();
