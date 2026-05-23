/**
 * Test script to verify cost data is being saved to database
 * Run this after fetching cost data via the dashboard
 */

const { db } = require('./dist/server/db');
const { costHistory } = require('./dist/shared/schema');
const { desc } = require('drizzle-orm');

async function testCostHistorySave() {
  console.log('Testing cost history database save...\n');
  
  try {
    // Query recent cost history records
    const recentRecords = await db
      .select()
      .from(costHistory)
      .orderBy(desc(costHistory.createdAt))
      .limit(10);
    
    console.log(`Found ${recentRecords.length} recent cost history records:\n`);
    
    if (recentRecords.length === 0) {
      console.log('❌ No cost history records found in database!');
      console.log('   This means cost data is NOT being saved.');
      console.log('   Please fetch cost data from the dashboard first.\n');
      return;
    }
    
    // Group by provider
    const byProvider = {};
    for (const record of recentRecords) {
      if (!byProvider[record.provider]) {
        byProvider[record.provider] = [];
      }
      byProvider[record.provider].push(record);
    }
    
    // Display summary
    for (const [provider, records] of Object.entries(byProvider)) {
      console.log(`\n${provider.toUpperCase()}:`);
      console.log(`  Records: ${records.length}`);
      
      const totalCost = records.reduce((sum, r) => sum + parseFloat(r.cost), 0);
      console.log(`  Total Cost: $${totalCost.toFixed(2)}`);
      
      // Show sample record
      const sample = records[0];
      console.log(`  Sample Record:`);
      console.log(`    Date: ${sample.date}`);
      console.log(`    Service: ${sample.serviceName}`);
      console.log(`    Cost: $${parseFloat(sample.cost).toFixed(2)}`);
      console.log(`    Account: ${sample.accountName}`);
    }
    
    console.log('\n✅ Cost history is being saved to database!');
    console.log('   Alert system should now work correctly.\n');
    
  } catch (error) {
    console.error('❌ Error querying cost history:', error);
  }
  
  process.exit(0);
}

testCostHistorySave();
