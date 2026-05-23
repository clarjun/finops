/**
 * Test script to check current costs in database
 * This helps you understand why alerts aren't triggering
 * Run with: node test-alert-costs.cjs
 */

const { db } = require('./server/db');
const { costHistory } = require('./shared/schema');
const { desc, gte } = require('drizzle-orm');

async function checkCurrentCosts() {
  console.log('Checking current costs in database...\n');
  
  try {
    // Get costs from the last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const recentCosts = await db.select()
      .from(costHistory)
      .where(gte(costHistory.date, thirtyDaysAgo))
      .orderBy(desc(costHistory.date))
      .limit(50);
    
    if (recentCosts.length === 0) {
      console.log('⚠️  No cost data found in the last 30 days!');
      console.log('This is why alerts are not triggering.');
      console.log('\nTo fix this:');
      console.log('1. Make sure cost data is being collected from your cloud providers');
      console.log('2. Check the /api/cost-data endpoint to see if data is being fetched');
      console.log('3. Verify your cloud credentials are configured correctly');
      return;
    }
    
    console.log(`Found ${recentCosts.length} cost records\n`);
    
    // Calculate totals by provider
    const totals = {
      daily: {},
      weekly: {},
      monthly: {},
    };
    
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay());
    weekStart.setHours(0, 0, 0, 0);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    
    recentCosts.forEach(record => {
      const provider = record.provider;
      const cost = parseFloat(record.cost);
      const recordDate = new Date(record.date);
      
      // Daily
      if (recordDate >= today) {
        totals.daily[provider] = (totals.daily[provider] || 0) + cost;
      }
      
      // Weekly
      if (recordDate >= weekStart) {
        totals.weekly[provider] = (totals.weekly[provider] || 0) + cost;
      }
      
      // Monthly
      if (recordDate >= monthStart) {
        totals.monthly[provider] = (totals.monthly[provider] || 0) + cost;
      }
    });
    
    console.log('=== DAILY COSTS (Today) ===');
    if (Object.keys(totals.daily).length === 0) {
      console.log('No costs recorded today');
    } else {
      Object.entries(totals.daily).forEach(([provider, cost]) => {
        console.log(`${provider.toUpperCase()}: $${cost.toFixed(2)}`);
      });
    }
    
    console.log('\n=== WEEKLY COSTS (This Week) ===');
    if (Object.keys(totals.weekly).length === 0) {
      console.log('No costs recorded this week');
    } else {
      Object.entries(totals.weekly).forEach(([provider, cost]) => {
        console.log(`${provider.toUpperCase()}: $${cost.toFixed(2)}`);
      });
    }
    
    console.log('\n=== MONTHLY COSTS (This Month) ===');
    if (Object.keys(totals.monthly).length === 0) {
      console.log('No costs recorded this month');
    } else {
      Object.entries(totals.monthly).forEach(([provider, cost]) => {
        console.log(`${provider.toUpperCase()}: $${cost.toFixed(2)}`);
      });
    }
    
    console.log('\n=== RECENT COST RECORDS ===');
    recentCosts.slice(0, 10).forEach(record => {
      console.log(`${record.date.toISOString().split('T')[0]} | ${record.provider.toUpperCase()} | ${record.serviceName} | $${parseFloat(record.cost).toFixed(2)}`);
    });
    
    console.log('\n💡 TIP: Set your alert thresholds below these amounts to test alerts');
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    process.exit(0);
  }
}

checkCurrentCosts();
