/**
 * Test script to check cloud accounts API
 * Run with: node test-cloud-accounts-api.cjs
 */

async function testCloudAccountsAPI() {
  console.log('Testing /api/cloud-accounts endpoint...\n');
  
  try {
    const response = await fetch('http://localhost:5000/api/cloud-accounts');
    
    console.log('Response status:', response.status);
    
    const data = await response.json();
    
    console.log('Response data:', JSON.stringify(data, null, 2));
    
    if (data.success && data.accounts) {
      console.log(`\n✓ Found ${data.accounts.length} cloud account(s)`);
      
      data.accounts.forEach((account, index) => {
        console.log(`\nAccount ${index + 1}:`);
        console.log(`  Provider: ${account.provider}`);
        console.log(`  Name: ${account.accountName}`);
        console.log(`  Account ID: ${account.accountId}`);
        console.log(`  Active: ${account.isActive}`);
      });
    } else {
      console.log('\n⚠ No accounts found or unexpected response format');
    }
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

testCloudAccountsAPI();
