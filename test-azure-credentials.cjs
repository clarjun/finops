// Test script to check Azure credentials decryption
const { Pool } = require('pg');
const crypto = require('crypto');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;

function getEncryptionKey() {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    console.warn('WARNING: ENCRYPTION_KEY not set. Using default key.');
    return crypto.scryptSync('default-dev-key-change-in-production', 'salt', KEY_LENGTH);
  }
  return crypto.scryptSync(key, 'azure-cost-dashboard-salt', KEY_LENGTH);
}

function decrypt(encryptedData) {
  if (!encryptedData) return '';
  
  try {
    const parts = encryptedData.split(':');
    if (parts.length !== 4) {
      throw new Error('Invalid encrypted data format');
    }
    
    const [saltHex, ivHex, encryptedHex, tagHex] = parts;
    
    const key = getEncryptionKey();
    const iv = Buffer.from(ivHex, 'hex');
    const encrypted = encryptedHex;
    const tag = Buffer.from(tagHex, 'hex');
    
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    console.error('Decryption error:', error.message);
    throw error;
  }
}

async function testAzureCredentials() {
  try {
    console.log('🔍 Checking Azure credentials...\n');
    
    const result = await pool.query(`
      SELECT id, provider, account_name, account_id, credentials, is_active
      FROM cloud_accounts
      WHERE provider = 'azure'
      ORDER BY created_at DESC
      LIMIT 1
    `);
    
    if (result.rows.length === 0) {
      console.log('❌ No Azure account found in database');
      await pool.end();
      return;
    }
    
    const account = result.rows[0];
    console.log(`✅ Found Azure account: ${account.account_name}`);
    console.log(`   Account ID: ${account.account_id}`);
    console.log(`   Active: ${account.is_active ? 'Yes' : 'No'}`);
    console.log(`   Credentials type: ${typeof account.credentials}`);
    console.log('');
    
    // Try to decrypt
    console.log('🔓 Attempting to decrypt credentials...');
    try {
      const decrypted = decrypt(account.credentials);
      console.log(`✅ Decryption successful, length: ${decrypted.length}`);
      
      const parsed = JSON.parse(decrypted);
      console.log('✅ Parsed credentials successfully');
      console.log('   Keys present:', Object.keys(parsed));
      console.log('');
      
      // Check required fields
      const required = ['tenantId', 'clientId', 'clientSecret'];
      const missing = required.filter(key => !parsed[key]);
      
      if (missing.length > 0) {
        console.log('❌ Missing required fields:', missing);
      } else {
        console.log('✅ All required fields present');
        console.log('   Tenant ID:', parsed.tenantId ? '✓' : '✗');
        console.log('   Client ID:', parsed.clientId ? '✓' : '✗');
        console.log('   Client Secret:', parsed.clientSecret ? '✓' : '✗');
        console.log('   Subscription ID:', parsed.subscriptionId || account.account_id);
      }
    } catch (error) {
      console.error('❌ Failed to decrypt/parse credentials:', error.message);
    }
    
    await pool.end();
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

testAzureCredentials();
