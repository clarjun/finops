/**
 * Test Service Cost Comparison
 * Compares costs from /api/services endpoint vs live-cost-fetcher
 */

async function testServiceCostComparison() {
  console.log('Testing Service Cost Comparison...\n');
  
  try {
    // Import after build
    const { fetchLiveCosts, aggregateCosts } = require('./dist/server/utils/live-cost-fetcher');
    
    // Calculate date range (month to date)
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(1);
    
    console.log(`Date range: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}\n`);
    
    // Method 1: Call /api/services endpoint (like frontend does)
    console.log('=== Method 1: /api/services endpoint ===');
    const apiResponse = await fetch('http://localhost:5173/api/services?provider=aws');
    const apiData = await apiResponse.json();
    
    if (!apiData.success) {
      console.error('API call failed:', apiData);
      process.exit(1);
    }
    
    console.log(`Fetched ${apiData.services.length} services from API`);
    
    const apiSagemaker = apiData.services.find(s => s.name.includes('SageMaker'));
    console.log(`\nSageMaker from API: $${apiSagemaker?.cost.toFixed(2) || 0}`);
    
    // Show all services from API
    console.log('\nAll services from API:');
    apiData.services.forEach(s => {
      if (s.name.includes('SageMaker')) {
        console.log(`  ${s.name}: $${s.cost.toFixed(2)} ⭐`);
      } else {
        console.log(`  ${s.name}: $${s.cost.toFixed(2)}`);
      }
    });
    
    // Method 2: Use live-cost-fetcher directly
    console.log('\n=== Method 2: live-cost-fetcher (direct call) ===');
    const records = await fetchLiveCosts(startDate, endDate, ['aws']);
    console.log(`Fetched ${records.length} records via live-cost-fetcher`);
    
    const aggregated = aggregateCosts(records);
    console.log(`\nAggregated into ${aggregated.byServiceDetailed.length} services`);
    
    const fetcherSagemaker = aggregated.byServiceDetailed.find(s => 
      s.provider === 'aws' && s.serviceName.includes('SageMaker')
    );
    console.log(`\nSageMaker from fetcher: $${fetcherSagemaker?.cost.toFixed(2) || 0}`);
    
    // Show all services from fetcher
    console.log('\nAll services from fetcher:');
    aggregated.byServiceDetailed
      .filter(s => s.provider === 'aws')
      .forEach(s => {
        if (s.serviceName.includes('SageMaker')) {
          console.log(`  ${s.serviceName}: $${s.cost.toFixed(2)} ⭐`);
        } else {
          console.log(`  ${s.serviceName}: $${s.cost.toFixed(2)}`);
        }
      });
    
    // Compare
    console.log('\n=== COMPARISON ===');
    const apiCost = apiSagemaker?.cost || 0;
    const fetcherCost = fetcherSagemaker?.cost || 0;
    
    console.log(`Method 1 (/api/services):        $${apiCost.toFixed(2)}`);
    console.log(`Method 2 (live-cost-fetcher):    $${fetcherCost.toFixed(2)}`);
    console.log(`Difference:                      $${Math.abs(fetcherCost - apiCost).toFixed(2)}`);
    
    if (Math.abs(fetcherCost - apiCost) < 0.01) {
      console.log('\n✅ VALUES MATCH! Both methods return the same cost.');
    } else {
      console.log('\n❌ MISMATCH! Values are different.');
      console.log('\nThis means the API endpoint and live-cost-fetcher are using different logic.');
      console.log('Check if the server was restarted after the code changes.');
    }
    
  } catch (error) {
    console.error('Error:', error);
    console.error(error.stack);
  }
  
  process.exit(0);
}

// Make sure server is running
console.log('⚠️  Make sure the server is running on http://localhost:5173');
console.log('   Run: npm run dev\n');

setTimeout(testServiceCostComparison, 1000);
