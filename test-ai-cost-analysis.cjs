/**
 * Test AI Cost Analysis
 * Tests the AI cost analyzer to verify it correctly identifies and aggregates AI service costs
 */

const { analyzeAWSAICosts } = require('./server/reports/ai-cost-analyzer.ts');

async function testAICostAnalysis() {
  console.log('========== AI COST ANALYSIS TEST ==========\n');
  
  try {
    // Test with current month
    const now = new Date();
    const startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    const endDate = now;
    
    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];
    
    console.log(`Testing AI cost analysis for ${startDateStr} to ${endDateStr}\n`);
    
    // You'll need to replace this with your actual AWS account ID
    const accountId = 'your-aws-account-id';
    
    const result = await analyzeAWSAICosts(accountId, startDateStr, endDateStr);
    
    console.log('AI Spend Analysis Results:');
    console.log('==========================');
    console.log(`Total AI Spend: $${result.totalAISpend.toFixed(2)}`);
    console.log(`AI % of Total: ${result.aiPercentageOfTotal.toFixed(2)}%`);
    console.log(`Top AI Service: ${result.topAIService}`);
    console.log(`\nAI Services Found: ${result.aiServices.length}`);
    
    if (result.aiServices.length > 0) {
      console.log('\nTop AI Services:');
      result.aiServices.slice(0, 10).forEach((service, idx) => {
        console.log(`  ${idx + 1}. ${service.service}: $${service.cost.toFixed(2)} (${service.percentage.toFixed(1)}%)`);
      });
    } else {
      console.log('\nNo AI services detected in this period.');
    }
    
    console.log('\n========== TEST COMPLETE ==========');
    
  } catch (error) {
    console.error('Error testing AI cost analysis:', error);
    process.exit(1);
  }
}

testAICostAnalysis();
