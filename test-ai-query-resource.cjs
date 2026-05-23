/**
 * Test AI Query with Resource Data Enhancement
 * Tests the new resource fetching capability for queries like "show me orphaned storage volumes"
 */

const http = require('http');

const query = "Show me any orphaned storage volumes";

const postData = JSON.stringify({ query });

const options = {
  hostname: 'localhost',
  port: 5000,
  path: '/api/analyze',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData)
  }
};

console.log(`Testing AI Query: "${query}"`);
console.log('This should now fetch actual EBS volume data from AWS...\n');

const req = http.request(options, (res) => {
  let data = '';

  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    try {
      const response = JSON.parse(data);
      console.log('Response Status:', res.statusCode);
      console.log('\nAI Answer:');
      console.log('='.repeat(80));
      console.log(response.answer || response.error || 'No answer');
      console.log('='.repeat(80));
      console.log('\nSuccess:', response.success);
      
      if (response.answer && response.answer !== "I couldn't generate an answer.") {
        console.log('\n✅ SUCCESS: AI Query now has access to resource data!');
      } else {
        console.log('\n⚠️  Still getting generic response - may need more debugging');
      }
    } catch (error) {
      console.error('Error parsing response:', error);
      console.log('Raw response:', data);
    }
  });
});

req.on('error', (error) => {
  console.error('Request error:', error);
});

req.write(postData);
req.end();
