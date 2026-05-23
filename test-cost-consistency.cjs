/**
 * Test Cost Consistency
 * Verifies that frontend dropdown, budget cards, and alert notifications
 * all show the same cost values
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

async function testCostConsistency() {
  console.log('=== Testing Cost Consistency ===\n');

  try {
    // 1. Get all budgets
    console.log('1. Fetching budgets...');
    const budgetsResponse = await makeRequest('/api/budgets');
    const budgets = budgetsResponse.budgets || [];
    
    if (budgets.length === 0) {
      console.log('❌ No budgets found. Please create a budget first.');
      return;
    }

    console.log(`✓ Found ${budgets.length} budget(s)\n`);

    // 2. For each budget, compare costs from different sources
    for (const budget of budgets) {
      console.log(`\n--- Budget: ${budget.budgetName} ---`);
      console.log(`Provider: ${budget.provider || 'All'}`);
      console.log(`Service: ${budget.serviceName || 'All'}`);
      console.log(`Period: ${budget.period}`);
      console.log(`Budget Amount: ${budget.amount}\n`);

      // Get spending from budget endpoint
      console.log('Fetching from /api/budgets/:id/spending...');
      const spendingResponse = await makeRequest(`/api/budgets/${budget.id}/spending`);
      const budgetCost = spendingResponse.currentSpending;
      console.log(`Budget Endpoint Cost: ${budgetCost.toFixed(2)}`);
      console.log(`Date Range: ${spendingResponse.dateRange?.start} to ${spendingResponse.dateRange?.end}`);

      // Get services breakdown
      console.log('\nFetching from /api/services...');
      const servicesResponse = await makeRequest('/api/services');
      
      // Find matching service
      let serviceCost = null;
      if (budget.serviceName && budget.provider) {
        const matchingService = servicesResponse.services?.find(
          s => s.name === budget.serviceName && s.provider === budget.provider
        );
        if (matchingService) {
          serviceCost = matchingService.cost;
          console.log(`Service Dropdown Cost: ${serviceCost.toFixed(2)}`);
        } else {
          console.log(`⚠ Service not found in dropdown: ${budget.provider}/${budget.serviceName}`);
        }
      } else {
        console.log('⚠ Budget applies to all services - cannot compare with dropdown');
      }

      // Compare values
      if (serviceCost !== null) {
        const difference = Math.abs(budgetCost - serviceCost);
        const percentDiff = (difference / budgetCost) * 100;
        
        console.log('\n--- Comparison ---');
        console.log(`Budget Endpoint: ${budgetCost.toFixed(2)}`);
        console.log(`Service Dropdown: ${serviceCost.toFixed(2)}`);
        console.log(`Difference: ${difference.toFixed(2)} (${percentDiff.toFixed(2)}%)`);
        
        if (difference < 0.01) {
          console.log('✅ VALUES MATCH!');
        } else if (percentDiff < 1) {
          console.log('⚠ Small difference (< 1%) - likely rounding');
        } else {
          console.log('❌ SIGNIFICANT DIFFERENCE DETECTED!');
          console.log('This indicates the endpoints are using different date ranges or data sources.');
        }
      }

      // Show alert threshold status
      const percentage = (budgetCost / parseFloat(budget.amount)) * 100;
      console.log(`\n--- Alert Status ---`);
      console.log(`Usage: ${percentage.toFixed(1)}%`);
      
      const alertThresholds = budget.alertThresholds || {};
      const triggeredThresholds = [];
      for (const [threshold, enabled] of Object.entries(alertThresholds)) {
        if (enabled && percentage >= parseInt(threshold)) {
          triggeredThresholds.push(threshold);
        }
      }
      
      if (triggeredThresholds.length > 0) {
        console.log(`🚨 Triggered thresholds: ${triggeredThresholds.join(', ')}%`);
        console.log(`Last alerted: ${budget.lastAlertedAt || 'Never'}`);
        console.log(`Last threshold: ${budget.lastAlertedThreshold || 'None'}%`);
      } else {
        console.log('✓ No thresholds triggered');
      }
    }

    console.log('\n\n=== Test Complete ===');
    console.log('If all values match, the cost consistency fix is working correctly!');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('Make sure the server is running on port 5000');
  }
}

// Run the test
testCostConsistency();
