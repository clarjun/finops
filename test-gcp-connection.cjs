// Test GCP Connection
// Run with: node test-gcp-connection.cjs

require('dotenv').config();

console.log('=== GCP Configuration Test ===\n');

// Check environment variables
console.log('1. Checking environment variables:');
console.log('   GCP_SERVICE_ACCOUNT_KEY:', process.env.GCP_SERVICE_ACCOUNT_KEY ? '✓ Set' : '✗ Not set');
console.log('   GCP_PROJECT_ID:', process.env.GCP_PROJECT_ID || '✗ Not set');
console.log('   GCP_BILLING_DATASET:', process.env.GCP_BILLING_DATASET || '✗ Not set');
console.log('   GCP_BILLING_TABLE:', process.env.GCP_BILLING_TABLE || '✗ Not set');

if (!process.env.GCP_SERVICE_ACCOUNT_KEY) {
  console.log('\n❌ GCP_SERVICE_ACCOUNT_KEY is not set!');
  process.exit(1);
}

// Try to parse the service account key
console.log('\n2. Parsing service account key:');
try {
  const credentials = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_KEY);
  console.log('   ✓ JSON is valid');
  console.log('   Project ID:', credentials.project_id);
  console.log('   Client Email:', credentials.client_email);
  console.log('   Private Key:', credentials.private_key ? '✓ Present' : '✗ Missing');
} catch (error) {
  console.log('   ✗ Failed to parse JSON:', error.message);
  console.log('\n   First 100 characters of GCP_SERVICE_ACCOUNT_KEY:');
  console.log('   ', process.env.GCP_SERVICE_ACCOUNT_KEY.substring(0, 100));
  process.exit(1);
}

// Try to initialize BigQuery client
console.log('\n3. Initializing BigQuery client:');
try {
  const { BigQuery } = require('@google-cloud/bigquery');
  const credentials = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_KEY);
  
  const bigQueryClient = new BigQuery({
    projectId: process.env.GCP_PROJECT_ID,
    credentials,
  });
  
  console.log('   ✓ BigQuery client created successfully');
  
  // Try a test query
  console.log('\n4. Testing BigQuery connection:');
  const query = `
    SELECT 
      DATE(usage_start_time) as usage_date,
      SUM(cost) as total_cost
    FROM 
      \`${process.env.GCP_PROJECT_ID}.${process.env.GCP_BILLING_DATASET}.${process.env.GCP_BILLING_TABLE}\`
    WHERE 
      DATE(usage_start_time) >= DATE_SUB(CURRENT_DATE(), INTERVAL 2 DAY)
    GROUP BY 
      usage_date
    LIMIT 1
  `;
  
  console.log('   Running test query...');
  bigQueryClient.query(query)
    .then(() => {
      console.log('   ✓ Test query successful!');
      console.log('\n✅ GCP is properly configured and connected!');
      process.exit(0);
    })
    .catch((error) => {
      console.log('   ✗ Test query failed:', error.message);
      console.log('\n   Possible issues:');
      console.log('   - Billing export table does not exist');
      console.log('   - Service account lacks permissions');
      console.log('   - Table name is incorrect');
      console.log('   - No billing data available yet (takes 24-48 hours)');
      console.log('\n   Full error:', error);
      process.exit(1);
    });
  
} catch (error) {
  console.log('   ✗ Failed to initialize BigQuery client:', error.message);
  console.log('\n   Full error:', error);
  process.exit(1);
}
