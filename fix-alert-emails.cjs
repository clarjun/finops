/**
 * Fix Alert Rule Email Addresses
 * Updates all alert rules to use the verified Resend email address
 */

const { db } = require('./dist/server/db');
const { alertRules } = require('./dist/shared/schema');

async function fixAlertEmails() {
  console.log('Fixing alert rule email addresses...\n');
  
  try {
    // Get current alert rules
    const rules = await db.select().from(alertRules);
    
    console.log(`Found ${rules.length} alert rules:\n`);
    
    rules.forEach(rule => {
      console.log(`  - ${rule.ruleName}`);
      console.log(`    Current emails: ${rule.emailRecipients}`);
      console.log(`    Enabled: ${rule.isEnabled === 1 ? 'Yes' : 'No'}`);
      console.log('');
    });
    
    // Update all rules to use verified email
    const result = await db.update(alertRules)
      .set({ emailRecipients: 'arl.rathod@gmail.com' })
      .returning();
    
    console.log(`✅ Updated ${result.length} alert rules to use: arl.rathod@gmail.com\n`);
    
    // Verify the update
    const updatedRules = await db.select().from(alertRules);
    console.log('Updated alert rules:');
    updatedRules.forEach(rule => {
      console.log(`  ✓ ${rule.ruleName}: ${rule.emailRecipients}`);
    });
    
    console.log('\n✅ All alert rules now use the verified Resend email address!');
    console.log('   You can now test by running: curl http://localhost:5173/api/budgets/check-alerts\n');
    
  } catch (error) {
    console.error('❌ Error:', error);
  }
  
  process.exit(0);
}

fixAlertEmails();
