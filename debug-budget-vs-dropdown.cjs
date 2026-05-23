/**
 * Debug Budget vs Dropdown Values
 * Comprehensive comparison to find the discrepancy
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

async function debug() {
  console.log('=== DEBUGGING BUDGET VS DROPDOWN VALUES ===\n');

  try {
    // 1. Get all budgets
    console.log('Step 1: Fetching all budgets...');
    const budgetsResponse = await makeRequest('/api/budgets');
    const budgets = budgetsResponse.budgets || [];
    
    if (budgets.length === 0) {
      console.log('❌ No budgets found.');
      return;
    }

    console.log(`✓ Found ${budgets.length} budget(s)\n`);

    // 2. For each budget with a specific service, compare values
    for (const budget of budgets) {
      if (!budget.serviceName || !budget.provider) {
        console.log(`⊘ Skipping budget "${budget.budgetName}" - applies to all services\n`);
        continue;
      }

      console.log(`\n${'='.repeat(60)}`);
      console.log(`BUDGET: ${budget.budgetName}`);
      console.log(`${'='.repeat(60)}`);
      console.log(`Provider: ${budget.provider}`);
      console.log(`Service: ${budget.serviceName}`);
      console.log(`Account ID: ${budget.accountId || 'Not specified'}`);
      console.log(`Period: ${budget.period}`);
      console.log(`Budget Amount: $${budget.amount}\n`);

      // 3. Get budget spending
      console.log('→ Fetching from /api/budgets/:id/spending...');
      const spendingResponse = await makeRequest(`/api/budgets/${budget.id}/spending`);
      
      if (!spendingResponse.success) {
        console.log(`  ❌ Error: ${spendingResponse.error}\n`);
        continue;
      }

      const budgetCost = spendingResponse.currentSpending;
      console.log(`  ✓ Budget Endpoint Cost: $${budgetCost.toFixed(2)}`);
      console.log(`    Date Range: ${spendingResponse.dateRange.start} to ${spendingResponse.dateRange.end}`);
      console.log(`    Usage: ${spendingResponse.percentage.toFixed(1)}%\n`);

      // 4. Get services dropdown
      console.log(`→ Fetching from /api/services?provider=${budget.provider}...`);
      const servicesResponse = await makeRequest(`/api/services?provider=${budget.provider}`);
      
      if (!servicesResponse.success) {
        console.log(`  ❌ Error: ${servicesResponse.error}\n`);
        continue;
      }

      // Find matching service
      const matchingService = servicesResponse.services.find(
        s => s.name === budget.serviceName
      );

      if (!matchingService) {
        console.log(`  ❌ Service "${budget.serviceName}" not found in dropdown`);
        console.log(`  Available services:`, servicesResponse.services.map(s => s.name).join(', '));
        console.log();
        continue;
      }

      const dropdownCost = matchingService.cost;
      console.log(`  ✓ Dropdown Cost: $${dropdownCost.toFixed(2)}\n`);

      // 5. Compare
      console.log('COMPARISON:');
      console.log(`  Budget Endpoint:  $${budgetCost.toFixed(2)}`);
      console.log(`  Dropdown:         $${dropdownCost.toFixed(2)}`);
      
      const difference = Math.abs(budgetCost - dropdownCost);
      const percentDiff = budgetCost > 0 ? (difference / budgetCost) * 100 : 0;
      
      console.log(`  Difference:       $${difference.toFixed(2)} (${percentDiff.toFixed(2)}%)`);
      
      if (difference < 0.01) {
        console.log(`  ✅ VALUES MATCH!`);
      } else if (percentDiff < 1) {
        console.log(`  ⚠️  Small difference (< 1%) - likely rounding`);
      } else {
        console.log(`  ❌ SIGNIFICANT DIFFERENCE!`);
        console.log(`\n  ANALYSIS:`);
        console.log(`  - Both endpoints should use month-to-date`);
        console.log(`  - Both should call live-cost-fetcher`);
        console.log(`  - Check server console logs for [getServiceCost] and [Budget Spending]`);
        console.log(`  - Verify the budget's provider and serviceName match exactly`);
      }
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log('DEBUG COMPLETE');
    console.log(`${'='.repeat(60)}\n`);

    console.log('NEXT STEPS:');
    console.log('1. Check your server console for detailed logs');
    console.log('2. Look for [getServiceCost] and [Budget Spending] messages');
    console.log('3. Verify the date ranges match');
    console.log('4. Check if the service names match exactly (case-sensitive)');

  } catch (error) {
    console.error('\n❌ Debug failed:', error.message);
    console.error('Make sure the server is running on port 5000');
  }
}

// Run the debug
debug();
