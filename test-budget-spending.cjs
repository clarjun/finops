/**
 * Test Budget Spending Endpoint
 * Verifies that the /api/budgets/:id/spending endpoint returns correct values
 */

const http = require('http');

const BASE_URL = 'http://localhost:5000';

async function makeRequest(path) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE_URL}${path}`, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    }).on('error', reject);
  });
}

async function testBudgetSpending() {
  console.log('=== Testing Budget Spending Endpoint ===\n');

  try {
    // 1. Get all budgets
    console.log('1. Fetching all budgets...');
    const budgetsResponse = await makeRequest('/api/budgets');
    const budgets = budgetsResponse.budgets || [];
    
    if (budgets.length === 0) {
      console.log('❌ No budgets found. Please create a budget first.');
      return;
    }

    console.log(`✓ Found ${budgets.length} budget(s)\n`);

    // 2. Test each budget's spending endpoint
    for (const budget of budgets) {
      console.log(`\n--- Testing Budget: ${budget.budgetName} ---`);
      console.log(`ID: ${budget.id}`);
      console.log(`Provider: ${budget.provider || 'All'}`);
      console.log(`Service: ${budget.serviceName || 'All'}`);
      console.log(`Period: ${budget.period}`);
      console.log(`Budget Amount: ${budget.amount}\n`);

      // Test the spending endpoint
      console.log(`Calling: GET /api/budgets/${budget.id}/spending`);
      const spendingResponse = await makeRequest(`/api/budgets/${budget.id}/spending`);
      
      console.log('\n--- Response ---');
      console.log(JSON.stringify(spendingResponse, null, 2));
      
      if (spendingResponse.success) {
        console.log('\n--- Parsed Values ---');
        console.log(`Current Spending: $${spendingResponse.currentSpending.toFixed(2)}`);
        console.log(`Budget Amount: $${spendingResponse.budgetAmount.toFixed(2)}`);
        console.log(`Percentage: ${spendingResponse.percentage.toFixed(1)}%`);
        console.log(`Date Range: ${spendingResponse.dateRange.start} to ${spendingResponse.dateRange.end}`);
        
        // Compare with service dropdown if applicable
        if (budget.serviceName && budget.provider) {
          console.log('\n--- Comparing with Service Dropdown ---');
          const servicesResponse = await makeRequest('/api/services');
          const matchingService = servicesResponse.services?.find(
            s => s.name === budget.serviceName && s.provider === budget.provider
          );
          
          if (matchingService) {
            console.log(`Service Dropdown Cost: $${matchingService.cost.toFixed(2)}`);
            console.log(`Budget Endpoint Cost: $${spendingResponse.currentSpending.toFixed(2)}`);
            
            const difference = Math.abs(matchingService.cost - spendingResponse.currentSpending);
            if (difference < 0.01) {
              console.log('✅ VALUES MATCH!');
            } else {
              console.log(`❌ MISMATCH! Difference: $${difference.toFixed(2)}`);
            }
          } else {
            console.log(`⚠ Service not found in dropdown: ${budget.provider}/${budget.serviceName}`);
          }
        }
      } else {
        console.log('❌ Error:', spendingResponse.error);
      }
    }

    console.log('\n\n=== Test Complete ===');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('Make sure the server is running on port 5000');
  }
}

// Run the test
testBudgetSpending();
