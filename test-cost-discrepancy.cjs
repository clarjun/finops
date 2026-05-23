/**
 * Test Cost Discrepancy
 * Compare dashboard vs reports cost data
 */

async function testCostDiscrepancy() {
  console.log('========================================');
  console.log('Testing Cost Discrepancy');
  console.log('========================================\n');

  const baseUrl = 'http://localhost:5173';
  
  // Get current date range (month-to-date)
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(1);
  
  const startDateStr = startDate.toISOString().split('T')[0];
  const endDateStr = endDate.toISOString().split('T')[0];
  
  console.log(`Date Range: ${startDateStr} to ${endDateStr}\n`);

  try {
    // Test 1: Dashboard cost-data endpoint
    console.log('1️⃣  Testing Dashboard /api/cost-data');
    console.log('   URL:', `${baseUrl}/api/cost-data?provider=aws&startDate=${startDateStr}&endDate=${endDateStr}`);
    
    const dashboardResponse = await fetch(
      `${baseUrl}/api/cost-data?provider=aws&startDate=${startDateStr}&endDate=${endDateStr}`
    );
    
    if (!dashboardResponse.ok) {
      const errorText = await dashboardResponse.text();
      throw new Error(`Dashboard API failed: ${dashboardResponse.status} - ${errorText}`);
    }
    
    const dashboardData = await dashboardResponse.json();
    console.log('   ✅ Dashboard Response:');
    console.log('   Total Cost:', dashboardData.totalCost);
    console.log('   Daily Trends:', dashboardData.dailyTrends?.length, 'days');
    console.log('   Services:', dashboardData.serviceBreakdown?.length);
    
    if (dashboardData.dailyTrends && dashboardData.dailyTrends.length > 0) {
      console.log('   First 3 days:');
      dashboardData.dailyTrends.slice(0, 3).forEach(day => {
        console.log(`     - ${day.date}: $${day.cost.toFixed(2)}`);
      });
      const manualSum = dashboardData.dailyTrends.reduce((sum, day) => sum + day.cost, 0);
      console.log('   Manual sum of daily costs:', manualSum.toFixed(2));
    }
    console.log();

    // Test 2: Reports finops endpoint
    console.log('2️⃣  Testing Reports /api/reports/finops');
    console.log('   URL:', `${baseUrl}/api/reports/finops?provider=aws&startDate=${startDateStr}&endDate=${endDateStr}`);
    
    const reportsResponse = await fetch(
      `${baseUrl}/api/reports/finops?provider=aws&startDate=${startDateStr}&endDate=${endDateStr}`
    );
    
    if (!reportsResponse.ok) {
      const errorText = await reportsResponse.text();
      throw new Error(`Reports API failed: ${reportsResponse.status} - ${errorText}`);
    }
    
    const reportsData = await reportsResponse.json();
    
    if (!reportsData.success) {
      throw new Error(`Reports returned error: ${reportsData.error}`);
    }
    
    const report = reportsData.report;
    
    console.log('   ✅ Reports Response:');
    console.log('   Total Spend MTD:', report.spendOverview.totalSpendMTD);
    console.log('   Forecast Month End:', report.spendOverview.forecastMonthEnd);
    console.log('   Days Into Month:', report.spendOverview.daysIntoMonth);
    console.log('   Days In Month:', report.spendOverview.daysInMonth);
    console.log('   Budget:', report.spendOverview.budget);
    console.log('   Budget Utilization:', report.spendOverview.budgetUtilization.toFixed(2) + '%');
    console.log('   Date Range:', report.dateRange);
    console.log('   Top Cost Drivers:', report.topCostDrivers?.length || 0);
    console.log('   Expensive Resources:', report.expensiveResources?.length || 0);
    console.log();

    // Test 3: Compare
    console.log('3️⃣  Comparison');
    console.log('   Dashboard Total:  $' + dashboardData.totalCost.toFixed(2));
    console.log('   Reports Total:    $' + report.spendOverview.totalSpendMTD.toFixed(2));
    const difference = Math.abs(dashboardData.totalCost - report.spendOverview.totalSpendMTD);
    console.log('   Difference:       $' + difference.toFixed(2));
    const match = difference < 0.01;
    console.log('   Match:', match ? '✅ YES' : '❌ NO');
    
    if (!match) {
      console.log('\n   ⚠️  VALUES DO NOT MATCH!');
      console.log('   This indicates the reports are not using the same data as the dashboard.');
    }
    console.log();

    // Test 4: Check if reports is using correct date range
    if (report.dateRange) {
      console.log('4️⃣  Report Date Range Check');
      console.log('   Requested Start:', startDateStr);
      console.log('   Actual Start:   ', report.dateRange.start);
      console.log('   Requested End:  ', endDateStr);
      console.log('   Actual End:     ', report.dateRange.end);
      const dateMatch = report.dateRange.start === startDateStr && report.dateRange.end === endDateStr;
      console.log('   Date Range Match:', dateMatch ? '✅ YES' : '❌ NO');
      
      if (!dateMatch) {
        console.log('\n   ⚠️  DATE RANGE MISMATCH!');
        console.log('   The report is using a different date range than requested.');
      }
      console.log();
    }

    // Test 5: Detailed breakdown
    console.log('5️⃣  Detailed Breakdown');
    console.log('   Dashboard Top 5 Services:');
    if (dashboardData.serviceBreakdown) {
      dashboardData.serviceBreakdown.slice(0, 5).forEach((service, idx) => {
        console.log(`     ${idx + 1}. ${service.name}: $${service.cost.toFixed(2)}`);
      });
    } else {
      console.log('     No service breakdown available');
    }
    console.log();
    
    console.log('   Reports Top 5 Cost Drivers:');
    if (report.topCostDrivers && report.topCostDrivers.length > 0) {
      report.topCostDrivers.slice(0, 5).forEach((driver, idx) => {
        console.log(`     ${idx + 1}. ${driver.service}: $${driver.currentCost.toFixed(2)} (${driver.trend > 0 ? '+' : ''}${driver.trend.toFixed(1)}%)`);
      });
    } else {
      console.log('     No cost drivers available');
    }
    console.log();

    // Test 6: Check if data is actually being fetched
    console.log('6️⃣  Data Availability Check');
    console.log('   Dashboard has data:', dashboardData.totalCost > 0 ? '✅ YES' : '❌ NO');
    console.log('   Reports has data:', report.spendOverview.totalSpendMTD > 0 ? '✅ YES' : '❌ NO');
    
    if (dashboardData.totalCost > 0 && report.spendOverview.totalSpendMTD === 0) {
      console.log('\n   ⚠️  CRITICAL ISSUE:');
      console.log('   Dashboard has data but Reports shows $0');
      console.log('   This means the report engine is not processing the data correctly.');
    }
    console.log();

    console.log('========================================');
    if (match) {
      console.log('✅ Test PASSED - Values match!');
    } else {
      console.log('❌ Test FAILED - Values do not match!');
      console.log('   Please check the server logs for more details.');
    }
    console.log('========================================');

    process.exit(match ? 0 : 1);

  } catch (error) {
    console.error('\n❌ Test failed with error:', error.message);
    if (error.stack) {
      console.error('\nStack trace:', error.stack);
    }
    process.exit(1);
  }
}

// Run the test
testCostDiscrepancy()
  .catch((error) => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });
