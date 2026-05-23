// Test Azure authentication
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
    return crypto.scryptSync('default-dev-key-change-in-production', 'salt', KEY_LENGTH);
  }
  return crypto.scryptSync(key, 'azure-cost-dashboard-salt', KEY_LENGTH);
}

function decrypt(encryptedData) {
  const parts = encryptedData.split(':');
  const [saltHex, ivHex, encryptedHex, tagHex] = parts;
  const key = getEncryptionKey();
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

async function testAzureAuth() {
  try {
    console.log('🔍 Testing Azure authentication...\n');
    
    const result = await pool.query(`
      SELECT credentials, account_id FROM cloud_accounts WHERE provider = 'azure' LIMIT 1
    `);
    
    if (result.rows.length === 0) {
      console.log('❌ No Azure account found');
      await pool.end();
      return;
    }
    
    const decrypted = decrypt(result.rows[0].credentials);
    const credentials = JSON.parse(decrypted);
    const subscriptionId = credentials.subscriptionId || result.rows[0].account_id;
    
    console.log('📋 Credentials:');
    console.log('   Tenant ID:', credentials.tenantId);
    console.log('   Client ID:', credentials.clientId);
    console.log('   Client Secret:', credentials.clientSecret ? '***' : 'MISSING');
    console.log('   Subscription ID:', subscriptionId);
    console.log('');
    
    // Test authentication
    console.log('🔐 Requesting access token from Azure AD...');
    const tokenUrl = `https://login.microsoftonline.com/${credentials.tenantId}/oauth2/v2.0/token`;
    
    const params = new URLSearchParams({
      client_id: credentials.clientId,
      scope: 'https://management.azure.com/.default',
      client_secret: credentials.clientSecret,
      grant_type: 'client_credentials',
    });
    
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Authentication failed:', response.status);
      console.error('   Error:', errorText);
      await pool.end();
      return;
    }
    
    const data = await response.json();
    console.log('✅ Access token obtained successfully!');
    console.log('   Token type:', data.token_type);
    console.log('   Expires in:', data.expires_in, 'seconds');
    console.log('');
    
    // Test Cost Management API
    console.log('💰 Testing Cost Management API...');
    const apiUrl = `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.CostManagement/query?api-version=2023-03-01`;
    
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    
    const costResponse = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${data.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'Usage',
        timeframe: 'Custom',
        timePeriod: { from: startDate, to: endDate },
        dataset: {
          granularity: 'Daily',
          aggregation: { totalCost: { name: 'PreTaxCost', function: 'Sum' } },
        },
      }),
    });
    
    if (!costResponse.ok) {
      const errorText = await costResponse.text();
      console.error('❌ Cost Management API failed:', costResponse.status);
      console.error('   Error:', errorText);
    } else {
      const costData = await costResponse.json();
      console.log('✅ Cost Management API working!');
      console.log('   Rows returned:', costData.properties?.rows?.length || 0);
    }
    
    await pool.end();
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

testAzureAuth();
