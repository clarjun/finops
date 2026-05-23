// Find GCP Datasets
// Run with: node find-gcp-datasets.cjs

require('dotenv').config();

console.log('=== Finding GCP Datasets ===\n');

const { BigQuery } = require('@google-cloud/bigquery');

try {
  const credentials = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_KEY);
  const projectId = process.env.GCP_PROJECT_ID;
  
  const bigQueryClient = new BigQuery({
    projectId,
    credentials,
  });
  
  console.log(`Searching for datasets in project: ${projectId}\n`);
  
  bigQueryClient.getDatasets()
    .then(([datasets]) => {
      if (datasets.length === 0) {
        console.log('❌ No datasets found in this project.');
        console.log('\nYou need to:');
        console.log('1. Go to GCP Console → Billing → Billing Export');
        console.log('2. Enable "Detailed usage cost" export');
        console.log('3. Create a BigQuery dataset for billing data');
        console.log('4. Wait 24-48 hours for data to populate');
        return;
      }
      
      console.log(`✅ Found ${datasets.length} dataset(s):\n`);
      
      datasets.forEach((dataset, index) => {
        console.log(`${index + 1}. Dataset: ${dataset.id}`);
        console.log(`   Location: ${dataset.location || 'Unknown'}`);
        console.log(`   Created: ${dataset.metadata?.creationTime ? new Date(parseInt(dataset.metadata.creationTime)).toISOString() : 'Unknown'}`);
        
        // Try to list tables in this dataset
        dataset.getTables()
          .then(([tables]) => {
            if (tables.length > 0) {
              console.log(`   Tables (${tables.length}):`);
              tables.forEach(table => {
                console.log(`      - ${table.id}`);
                // Check if it looks like a billing export table
                if (table.id.includes('gcp_billing_export') || table.id.includes('billing')) {
                  console.log(`        ⭐ This looks like a billing export table!`);
                }
              });
            } else {
              console.log(`   Tables: None`);
            }
            console.log('');
          })
          .catch(err => {
            console.log(`   Tables: Error listing tables - ${err.message}`);
            console.log('');
          });
      });
      
      console.log('\n💡 Update your .env file with the correct dataset and table names.');
      
    })
    .catch((error) => {
      console.log('❌ Error listing datasets:', error.message);
      console.log('\nPossible issues:');
      console.log('- Service account lacks BigQuery permissions');
      console.log('- Project ID is incorrect');
      console.log('\nFull error:', error);
    });
  
} catch (error) {
  console.log('❌ Error:', error.message);
}
