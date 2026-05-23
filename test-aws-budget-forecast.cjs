/**
 * Test AWS Budget and Forecast Integration
 * Tests the new AWS Budgets API and Cost Forecast API integration
 */

async function testBudgetForecast() {
  console.log('========================================');
  console.log('Testing AWS Budget & Forecast Integration');
  console.log('========================================\n');

  const baseUrl = 'http://localhost:5173';
  
  // Test 1: Current month (should show budget)
  const now = new Date();
  // Force March 1 as start date to ensure single month
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startDateStr = startOfMonth.toISOString().split('T')[0];
  const endDateStr = now.toISOString().split('T')[0];
  
  console.log('1️⃣  Test: Current Month Range (should show budget)');
  console.log(`   Date Range: ${startDateStr} to ${endDateStr}`);
  console.log(`   Note: Start date is ${startOfMonth.getMonth() + 1}/${startOfMonth.getDate()}, End date is ${now.getMonth() + 1}/${now.getDate()}\n`);

  try {
    const response = await fetch(
      `${baseUrl}/api/reports/finops?provider=aws&startDate=${startDateStr}&endDate=${endDateStr}`
    );
    
    if (!response.ok) {
      throw new Error(`API failed: ${response.status}`);
    }
    
    const data = await response.json();
    const overview = data.report.spendOverview;
    
    console.log('   ✅ Response:');
    console.log('   Total Spend MTD:', overview.totalSpendMTD.toFixed(2));
    console.log('   Forecast Month End:', overview.forecastMonthEnd.toFixed(2));
    console.log('   Budget:', overview.budget !== undefined ? overview.budget.toFixed(2) : 'N/A');
    console.log('   Budget Utilization:', overview.budgetUtilization !== undefined ? overview.budgetUtilization.toFixed(2) + '%' : 'N/A');
    console.log('   Potential Savings:', overview.potentialSavings !== undefined ? overview.potentialSavings.toFixed(2) : 'N/A');
    console.log('   Budget Unavailable Reason:', overview.budgetUnavailableReason || 'None');
    
    if (overview.budget !== undefined) {
      console.log('\n   ✅ Budget data is shown (correct for current month)');
    } else {
      console.log('\n   ⚠️  Budget data is hidden');
      console.log('   Reason:', overview.budgetUnavailableReason);
    }
    console.log();

  } catch (error) {
    console.error('\n❌ Test 1 failed:', error.message);
  }

  // Test 2: Multi-month range (should NOT show budget)
  const twoMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  const multiStartStr = twoMonthsAgo.toISOString().split('T')[0];
  
  console.log('2️⃣  Test: Multi-Month Range (should hide budget)');
  console.log(`   Date Range: ${multiStartStr} to ${endDateStr}\n`);

  try {
    const response = await fetch(
      `${baseUrl}/api/reports/finops?provider=aws&startDate=${multiStartStr}&endDate=${endDateStr}`
    );
    
    if (!response.ok) {
      throw new Error(`API failed: ${response.status}`);
    }
    
    const data = await response.json();
    const overview = data.report.spendOverview;
    
    console.log('   ✅ Response:');
    console.log('   Total Spend:', overview.totalSpendMTD.toFixed(2));
    console.log('   Budget:', overview.budget !== undefined ? overview.budget.toFixed(2) : 'N/A');
    console.log('   Budget Unavailable Reason:', overview.budgetUnavailableReason || 'None');
    
    if (overview.budget === undefined && overview.budgetUnavailableReason) {
      console.log('\n   ✅ Budget data is correctly hidden for multi-month range');
      console.log('   Message:', overview.budgetUnavailableReason);
    } else {
      console.log('\n   ❌ Budget data should be hidden for multi-month range');
    }
    console.log();

  } catch (error) {
    console.error('\n❌ Test 2 failed:', error.message);
  }

  // Test 3: Previous month (should NOT show budget)
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
  const lastMonthStartStr = lastMonth.toISOString().split('T')[0];
  const lastMonthEndStr = lastMonthEnd.toISOString().split('T')[0];
  
  console.log('3️⃣  Test: Previous Month (should hide budget)');
  console.log(`   Date Range: ${lastMonthStartStr} to ${lastMonthEndStr}\n`);

  try {
    const response = await fetch(
      `${baseUrl}/api/reports/finops?provider=aws&startDate=${lastMonthStartStr}&endDate=${lastMonthEndStr}`
    );
    
    if (!response.ok) {
      throw new Error(`API failed: ${response.status}`);
    }
    
    const data = await response.json();
    const overview = data.report.spendOverview;
    
    console.log('   ✅ Response:');
    console.log('   Total Spend:', overview.totalSpendMTD.toFixed(2));
    console.log('   Budget:', overview.budget !== undefined ? overview.budget.toFixed(2) : 'N/A');
    console.log('   Budget Unavailable Reason:', overview.budgetUnavailableReason || 'None');
    
    if (overview.budget === undefined && overview.budgetUnavailableReason) {
      console.log('\n   ✅ Budget data is correctly hidden for previous month');
      console.log('   Message:', overview.budgetUnavailableReason);
    } else {
      console.log('\n   ❌ Budget data should be hidden for previous month');
    }
    console.log();

  } catch (error) {
    console.error('\n❌ Test 3 failed:', error.message);
  }

  console.log('========================================');
  console.log('✅ All tests completed');
  console.log('========================================');
}

// Run the test
testBudgetForecast()
  .catch((error) => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });
