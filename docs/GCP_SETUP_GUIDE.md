# GCP Real-Time Cost Data Setup Guide

This guide explains how to configure real-time GCP cost data for the FinOps Dashboard using BigQuery Billing Export.

## Prerequisites

1. **GCP Project** with billing enabled
2. **Billing Account Admin** or **Billing Account Costs Manager** role
3. **BigQuery API** enabled in your project

## Step 1: Enable BigQuery Billing Export

### 1.1 Enable BigQuery API

```bash
gcloud services enable bigquery.googleapis.com
```

### 1.2 Create BigQuery Dataset

Create a dataset to store billing data (use multi-region US or EU for retroactive data):

```bash
bq mk --location=US --dataset my-project:cloud_billing_data
```

### 1.3 Configure Billing Export

1. Go to [Google Cloud Console → Billing → Billing Export](https://console.cloud.google.com/billing)
2. Select your billing account
3. Click on **BigQuery export** tab
4. Under **Standard usage cost**, click **Edit Settings**
5. Select your project and dataset (e.g., `my-project.cloud_billing_data`)
6. Click **Save**

**Note**: It takes a few hours for data to start appearing. Multi-region datasets backfill data from the start of the previous month.

## Step 2: Create Service Account

### 2.1 Create Service Account

```bash
gcloud iam service-accounts create finops-dashboard \
  --display-name="FinOps Dashboard Service Account"
```

### 2.2 Grant BigQuery Permissions

```bash
# Grant BigQuery User role for querying
gcloud projects add-iam-policy-binding my-project \
  --member="serviceAccount:finops-dashboard@my-project.iam.gserviceaccount.com" \
  --role="roles/bigquery.user"

# Grant BigQuery Data Viewer role for reading billing data
gcloud projects add-iam-policy-binding my-project \
  --member="serviceAccount:finops-dashboard@my-project.iam.gserviceaccount.com" \
  --role="roles/bigquery.dataViewer"
```

### 2.3 Create and Download Service Account Key

```bash
gcloud iam service-accounts keys create finops-dashboard-key.json \
  --iam-account=finops-dashboard@my-project.iam.gserviceaccount.com
```

This creates a JSON file `finops-dashboard-key.json` with your credentials.

## Step 3: Configure Environment Variables

Add the following environment variables to your project:

1. **GCP_SERVICE_ACCOUNT_KEY**: The entire contents of your `finops-dashboard-key.json` file as a JSON string
   ```json
   {"type":"service_account","project_id":"my-project","private_key_id":"...","private_key":"..."}
   ```

2. **GCP_PROJECT_ID**: Your GCP project ID (e.g., `my-project-123456`)

3. **GCP_BILLING_TABLE**: Your billing export table name, typically:
   ```
   gcp_billing_export_v1_<BILLING_ACCOUNT_ID>
   ```
   
   To find your billing account ID:
   ```bash
   gcloud billing accounts list
   ```
   
   The table name will be like: `gcp_billing_export_v1_012345_678901_ABCDEF`
   
   Replace hyphens with underscores: `gcp_billing_export_v1_012345_678901_ABCDEF`

4. **GCP_BILLING_DATASET** (Optional): Dataset name containing billing data
   - Default: `cloud_billing_data`
   - Only set if you used a different name

### Example Configuration

```bash
GCP_SERVICE_ACCOUNT_KEY={"type":"service_account","project_id":"my-project",...}
GCP_PROJECT_ID=my-project-123456
GCP_BILLING_TABLE=gcp_billing_export_v1_012345_678901_ABCDEF
GCP_BILLING_DATASET=cloud_billing_data
```

## Step 4: Verify Configuration

1. **Restart the application** to load new environment variables
2. Check the startup logs for:
   ```
   GCP BigQuery Billing: CONFIGURED ✓
   ```
3. Navigate to the **GCP tab** in the dashboard
4. You should see real GCP cost data instead of sample data

## Troubleshooting

### "GCP BigQuery Billing: Not configured"

- Verify all environment variables are set correctly
- Check that `GCP_SERVICE_ACCOUNT_KEY` contains valid JSON
- Ensure the service account has BigQuery permissions

### "GCP BigQuery connectivity test failed"

- Verify billing export is enabled and has data (wait a few hours after setup)
- Check that the table name is correct (use underscores, not hyphens)
- Verify the dataset exists: `bq ls -d`
- Check table exists: `bq ls cloud_billing_data`

### "Failed to fetch GCP data: Table not found"

- Verify the billing export table name matches your configuration
- Check if data has been exported yet (takes several hours)
- Ensure you're using the correct dataset name

### "Permission denied"

- Verify service account has `roles/bigquery.user` and `roles/bigquery.dataViewer`
- Check IAM policy bindings:
  ```bash
  gcloud projects get-iam-policy my-project
  ```

## Data Structure

The BigQuery billing export table contains:

- **usage_start_time**: When the resource usage started
- **service.description**: GCP service name (e.g., "Compute Engine")
- **location.region**: GCP region (e.g., "us-central1")
- **cost**: Cost in billing currency
- **labels**: Resource labels/tags

The dashboard queries this data and groups it by date, service, and region for cost analysis.

## Security Best Practices

1. **Rotate service account keys** regularly (every 90 days)
2. **Use least-privilege permissions** - only grant necessary roles
3. **Never commit** service account keys to version control
5. **Monitor access** using Cloud Audit Logs

## Cost Considerations

- **BigQuery storage**: Free for billing export data
- **BigQuery queries**: First 1 TB/month free, then $5/TB
- **Typical usage**: A few GB of queries per month (~$0.01/month)

## Additional Resources

- [GCP Billing Export Documentation](https://cloud.google.com/billing/docs/how-to/export-data-bigquery)
- [BigQuery Billing Schema](https://cloud.google.com/billing/docs/how-to/export-data-bigquery-tables)
- [Service Account Best Practices](https://cloud.google.com/iam/docs/best-practices-service-accounts)
- [Example Billing Queries](https://cloud.google.com/billing/docs/how-to/bq-examples)
