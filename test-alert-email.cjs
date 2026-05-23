/**
 * Test Alert Email Sending
 * This script tests if alert rule emails are being sent correctly
 */

async function testAlertEmail() {
  console.log('Testing Alert Email System...\n');
  
  // Import after build
  const { EmailService } = require('./dist/server/email-service');
  
  const emailService = new EmailService();
  
  console.log('Sending test alert email...');
  
  const success = await emailService.sendCostAlert({
    to: ['arl.rathod@gmail.com'], // Your email
    ruleName: 'TEST ALERT - AWS Sagemaker',
    currentCost: 6593.00,
    threshold: 10.00,
    period: 'monthly'
  });
  
  if (success) {
    console.log('\n✅ Test email sent successfully!');
    console.log('   Check your inbox at: arl.rathod@gmail.com');
    console.log('   Subject: 🚨 Cost Alert: TEST ALERT - AWS Sagemaker\n');
  } else {
    console.log('\n❌ Failed to send test email');
    console.log('   Check the error messages above');
    console.log('   Verify RESEND_API_KEY is set in .env file\n');
  }
  
  process.exit(0);
}

testAlertEmail().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
