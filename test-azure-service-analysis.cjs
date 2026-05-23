/**
 * Test Azure Service Analysis
 * Tests the full service analysis flow for Azure including user attribution
 */

const { fullServiceAnalysis } = require('./server/analysis/full-analysis-engine');

async function testAzureServiceAnalysis() {
  console.log('========================================');
  console.log('Testing Azure Service Analysis');
  console.log('========================================\n');

  try {
    // Test with a common Azure service
    const serviceName = 'Virtual Machines'; // Change this to match your Azure services
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    console.log(`Service: ${serviceName}`);
    console.log(`Date Range: ${startDate} to ${endDate}\n`);

    const result = await fullServiceAnalysis(
      serviceName,
      startDate,
      endDate,
      'azure'
    );

    console.log('\n========================================');
    console.log('ANALYSIS RESULTS');
    console.log('========================================\n');

    console.log('📊 Cost Summary:');
    console.log(`   Total Cost: $${result.totalCost.toFixed(2)}`);
    console.log(`   On-Demand: ${result.purchaseModel.onDemandPercent.toFixed(1)}%`);
    console.log(`   Reserved: ${result.purchaseModel.reservedPercent.toFixed(1)}%\n`);

    console.log('💰 Savings Potential:');
    console.log(`   Estimated Savings: $${result.savings.estimatedSavingsAmount.toFixed(2)}`);
    console.log(`   Savings Percent: ${result.savings.estimatedSavingsPercent.toFixed(1)}%`);
    if (result.savings.breakdown && result.savings.breakdown.length > 0) {
      console.log('   Breakdown:');
      result.savings.breakdown.forEach((reason, idx) => {
        console.log(`     ${idx + 1}. ${reason}`);
      });
    }
    console.log();

    console.log('🏗️  Infrastructure:');
    console.log(`   Resources Found: ${result.infrastructure.resources?.length || 0}`);
    if (result.infrastructure.resources && result.infrastructure.resources.length > 0) {
      console.log('   Top 5 Resources:');
      result.infrastructure.resources
        .slice(0, 5)
        .forEach((resource, idx) => {
          console.log(`     ${idx + 1}. ${resource.type} - $${resource.estimatedMonthlyCost.toFixed(2)}`);
        });
    }
    console.log();

    console.log('👥 User Attribution:');
    if (result.userAttribution && result.userAttribution.length > 0) {
      console.log(`   Owners Found: ${result.userAttribution.length}`);
      console.log('   Top 5 Owners:');
      result.userAttribution
        .slice(0, 5)
        .forEach((user, idx) => {
          console.log(`     ${idx + 1}. ${user.owner}`);
          console.log(`        Cost: $${user.totalCost.toFixed(2)}`);
          console.log(`        Resources: ${user.resourceCount}`);
          console.log(`        Percentage: ${((user.totalCost / result.totalCost) * 100).toFixed(1)}%`);
        });
    } else {
      console.log('   ⚠️  No user attribution data available');
      console.log('   Tip: Add "Owner" tags to your Azure resources for cost attribution');
    }
    console.log();

    console.log('🤖 AI Insights:');
    console.log(`   Risk Level: ${result.aiInsights.riskLevel}`);
    console.log(`   Confidence: ${result.aiInsights.confidenceScore}%`);
    console.log(`   Root Cause: ${result.aiInsights.rootCause}`);
    console.log('\n   Top Cost Drivers:');
    result.aiInsights.topDrivers.forEach((driver, idx) => {
      console.log(`     ${idx + 1}. ${driver}`);
    });
    console.log('\n   Recommendations:');
    result.aiInsights.recommendations.forEach((rec, idx) => {
      console.log(`     ${idx + 1}. ${rec}`);
    });
    console.log();

    console.log('📦 Cost Breakdown:');
    const breakdownEntries = Object.entries(result.costBreakdown);
    console.log(`   Meter Categories: ${breakdownEntries.length}`);
    if (breakdownEntries.length > 0) {
      console.log('   Top 5 Categories:');
      breakdownEntries
        .slice(0, 5)
        .forEach(([category, data], idx) => {
          const totalCost = Object.values(data).reduce((sum, rg) => sum + rg.cost, 0);
          console.log(`     ${idx + 1}. ${category} - $${totalCost.toFixed(2)}`);
        });
    }

    console.log('\n========================================');
    console.log('✅ Test completed successfully!');
    console.log('========================================\n');

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error('\nStack trace:', error.stack);
    process.exit(1);
  }
}

// Run the test
testAzureServiceAnalysis()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });
