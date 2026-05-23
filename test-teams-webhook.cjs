/**
 * Test Teams Incoming Webhook
 * Replace WEBHOOK_URL with your actual Teams webhook URL
 */

const WEBHOOK_URL = 'https://cirruslabsio.webhook.office.com/webhookb2/a0e7a0a8-9f51-4ab0-b434-5f083f4564a9@a858d9da-8dfa-4b12-9f90-d0448a34f6d1/IncomingWebhook/c8f360ff38564edc8010c6d32deac834/5513f796-8d66-4db9-88ee-8dd825892ba7/V2wJtP1fILQTz7ggJ_hmLmiNRgfU-ZJYANFNJ35TU-zhw1';

async function testTeamsWebhook() {
  console.log('Testing Teams Incoming Webhook...\n');
  
  // Teams MessageCard format
  const payload = {
    "@type": "MessageCard",
    "@context": "https://schema.org/extensions",
    "summary": "Cost Alert: AWS - Sagemaker",
    "themeColor": "FF0000",
    "title": "🚨 Cost Alert: AWS - Sagemaker",
    "sections": [{
      "activityTitle": "Cost Alert Triggered",
      "activitySubtitle": "monthly spending exceeded threshold",
      "facts": [
        { "name": "Current Cost:", "value": "$6593.00" },
        { "name": "Threshold:", "value": "$10.00" },
        { "name": "Provider:", "value": "AWS" },
        { "name": "Service:", "value": "Sagemaker" },
        { "name": "Period:", "value": "monthly" }
      ],
      "markdown": true
    }]
  };
  
  try {
    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    
    if (response.ok) {
      console.log('✅ Webhook sent successfully!');
      console.log('   Check your Teams channel for the message.');
    } else {
      const errorText = await response.text();
      console.error('❌ Webhook failed:');
      console.error('   Status:', response.status);
      console.error('   Error:', errorText);
    }
  } catch (error) {
    console.error('❌ Error sending webhook:', error.message);
  }
}

testTeamsWebhook();
