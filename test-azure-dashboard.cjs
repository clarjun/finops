/**
 * Test Azure Dashboard Data
 * Tests all Azure endpoints used by the dashboard
 */

async function testAzureDashboard() {
  const fetch = (await import('node-fetch')).default;
  const BASE_URL = 'http://localhost:5000';
  
  console.log('\n========== TESTING AZURE DASHBOARD ==========\n');
  
  try {
    // Test 1: Check Azure configuration
    console.log('1. Testing Azure Configuration...');
    const configRes = await fetch(`${BASE_URL}/api/azure/config`);
    const configData = await configRes.json();
    console.log('   Status:', configRes.status);
    console.log('   Response:', JSON.stringify(configData, null, 2));
    
    if (!configRes.ok) {
      console.log('   ❌ Azure not configured');
      return;
    }
    
    // Test 2: Get cost data for Azure
    console.log('\n2. Testing Cost Data Endpoint (provider=azure)...');
    const costRes = await fetch(`${BASE_URL}/api/cost-data?provider=azure`);
    const costData = await costRes.json();
    console.log('   Status:', costRes.status);
    
    if (!costRes.ok) {
      console.log('   ❌ Error:', costData);
      return;
    }
    
    console.log('   Total Cost:', costData.totalCost);
    console.log('   Services Count:', costData.services?.length || 0);
    if (costData.services && costData.services.length > 0) {
      console.log('   Sample Services:', costData.services.slice(0, 3));
    }
    
    // Test 3: Get services for Azure
    console.log('\n3. Testing Services Endpoint (provider=azure)...');
    const servicesRes = await fetch(`${BASE_URL}/api/services?provider=azure`);
    const servicesData = await servicesRes.json();
    console.log('   Status:', servicesRes.status);
    
    if (!servicesRes.ok) {
      console.log('   ❌ Error:', servicesData);
      return;
    }
    
    console.log('   Services Count:', servicesData.services?.length || 0);
    if (servicesData.services && servicesData.services.length > 0) {
      console.log('   Sample Services:', servicesData.services.slice(0, 5).map(s => ({
        name: s.name,
        cost: s.cost
      })));
    }
    
    // Test 4: Get anomalies for Azure
    console.log('\n4. Testing Anomalies Endpoint (provider=azure)...');
    const anomaliesRes = await fetch(`${BASE_URL}/api/anomalies?provider=azure`);
    const anomaliesData = await anomaliesRes.json();
    console.log('   Status:', anomaliesRes.status);
    console.log('   Anomalies Count:', anomaliesData.anomalies?.length || 0);
    
    // Test 5: Test service analysis for Azure service
    if (servicesData.services && servicesData.services.length > 0) {
      const testService = servicesData.services[0].name;
      console.log(`\n5. Testing Service Analysis for "${testService}"...`);
      
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(1);
      
      const analysisRes = await fetch(`${BASE_URL}/api/service-analysis`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          service: testService,
          provider: 'azure',
          startDate: startDate.toISOString().split('T')[0],
          endDate: endDate.toISOString().split('T')[0],
        }),
      });
      
      const analysisData = await analysisRes.json();
      console.log('   Status:', analysisRes.status);
      
      if (analysisRes.ok) {
        console.log('   ✓ Analysis successful');
        console.log('   Total Cost:', analysisData.data?.totalCost);
        console.log('   Savings:', analysisData.data?.savings?.estimatedSavingsAmount);
      } else {
        console.log('   ❌ Error:', analysisData);
      }
    }
    
    console.log('\n========== TEST COMPLETE ==========\n');
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

testAzureDashboard();
