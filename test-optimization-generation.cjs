/**
 * Test script to generate optimization recommendations
 * Run with: node test-optimization-generation.cjs
 */

async function testOptimizationGeneration() {
  console.log('Testing optimization recommendation generation...\n');
  
  try {
    const response = await fetch('http://localhost:5000/api/optimization/recommendations/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    });
    
    const data = await response.json();
    
    console.log('Response status:', response.status);
    console.log('Response data:', JSON.stringify(data, null, 2));
    
    if (response.ok) {
      console.log('\n✓ Recommendations generated successfully!');
      
      // Now fetch the recommendations
      console.log('\nFetching recommendations...');
      const fetchResponse = await fetch('http://localhost:5000/api/optimization/recommendations');
      const fetchData = await fetchResponse.json();
      
      console.log('Recommendations count:', fetchData.recommendations?.length || 0);
      
      if (fetchData.recommendations && fetchData.recommendations.length > 0) {
        console.log('\nSample recommendation:');
        console.log(JSON.stringify(fetchData.recommendations[0], null, 2));
      } else {
        console.log('\n⚠ No recommendations found in database');
      }
    } else {
      console.error('\n✗ Failed to generate recommendations');
    }
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

testOptimizationGeneration();
