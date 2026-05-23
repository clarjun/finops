# 🔧 GCP Real-Time Cost Data Setup Guide

This guide will help you connect your application to real-time Google Cloud Platform (GCP) cost data using BigQuery billing export.

---

## 📋 Prerequisites

- Active GCP Project with billing enabled
- Admin access to GCP Console
- Billing export permissions

---

## 🚀 Step-by-Step Setup

### **Step 1: Enable Cloud Billing Export to BigQuery**

1. **Open GCP Console**: https://console.cloud.google.com
2. Navigate to **Billing** → **Billing Export**
3. Click **"Edit Settings"** for **"Detailed usage cost"**
4. Configure the export:
   - **Project**: Select your project (e.g., `ai-coe-442511`)
   - **Dataset**: Create or select a dataset (e.g., `cloud_billing_data`)
   - **Table prefix**: Leave default or customize
5. Click **"Save"**
6. **Note the table name** - it will look like:
   ```
   gcp_billing_export_resource_v1_00880C_2156EB_19C000
   ```

> ⏱️ **Note**: It may take 24-48 hours for billing data to start appearing in BigQuery after enabling export.

---

### **Step 2: Create a Service Account**

1. Navigate to **IAM & Admin** → **Service Accounts**
2. Click **"Create Service Account"**
3. Configure the service account:
   - **Name**: `cloud-cost-analyzer` (or your preferred name)
   - **Description**: "Service account for cloud cost analysis"
4. Click **"Create and Continue"**

---

### **Step 3: Grant Required Permissions**

Grant the following roles to your service account:

1. **BigQuery Data Viewer**
   - Allows reading billing data from BigQuery
   
2. **BigQuery Job User**
   - Allows running queries against BigQuery

To grant roles:
- Click on the service account
- Go to **"Permissions"** tab
- Click **"Grant Access"**
- Add each role listed above

---

### **Step 4: Create and Download Service Account Key**

1. Click on your service account
2. Go to **"Keys"** tab
3. Click **"Add Key"** → **"Create new key"**
4. Select **JSON** format
5. Click **"Create"**
6. The JSON key file will be downloaded automatically

> 🔒 **Security**: Keep this key file secure! It provides access to your GCP resources.

---

### **Step 5: Configure Environment Variables**

1. Open your `.env` file
2. Add/update the following variables:

```env
# GCP Configuration
GCP_SERVICE_ACCOUNT_KEY={"type":"service_account","project_id":"YOUR_PROJECT_ID",...entire JSON content...}
GCP_PROJECT_ID=your-project-id
GCP_BILLING_DATASET=cloud_billing_data
GCP_BILLING_TABLE=gcp_billing_export_resource_v1_XXXXXX_XXXXXX_XXXXXX
```

#### **How to format GCP_SERVICE_ACCOUNT_KEY:**

The JSON key file you downloaded needs to be on a **single line**. Here's how:

**Option 1: Manual (Copy-Paste)**
```bash
# Open the downloaded JSON file
# Copy the entire content
# Remove all line breaks (make it one line)
# Paste into .env file
```

**Option 2: Using Command Line (Linux/Mac)**
```bash
cat your-key-file.json | tr -d '\n' | pbcopy
# Now paste into .env file
```

**Option 3: Using Command Line (Windows PowerShell)**
```powershell
Get-Content your-key-file.json -Raw | Set-Clipboard
# Now paste into .env file
```

---

### **Step 6: Verify Configuration**

Your `.env` file should look like this:

```env
GCP_SERVICE_ACCOUNT_KEY={"type":"service_account","project_id":"ai-coe-442511","private_key_id":"abc123...","private_key":"-----BEGIN PRIVATE KEY-----\nMIIE...","client_email":"cloud-cost-analyzer@ai-coe-442511.iam.gserviceaccount.com",...}
GCP_PROJECT_ID=ai-coe-442511
GCP_BILLING_DATASET=cloud_billing_data
GCP_BILLING_TABLE=gcp_billing_export_resource_v1_00880C_2156EB_19C000
```

---

### **Step 7: Restart Your Application**

```bash
# Stop the application if running
# Then restart
npm run dev
```

---

## ✅ Verify Connection

### **Check Console Logs**

When your application starts, you should see:

```
GCP BigQuery client initialized for project: ai-coe-442511
GCP BigQuery Billing: CONFIGURED ✓
```

### **Test the API**

1. Open your browser
2. Navigate to: `http://localhost:5000/api/cost-data?provider=gcp`
3. You should see real GCP cost data (not sample data)

---

## 🔍 Troubleshooting

### **Issue: "GCP credentials not configured"**

**Solution:**
- Verify all 4 environment variables are set
- Ensure `GCP_SERVICE_ACCOUNT_KEY` is on a single line
- Check for any syntax errors in the JSON

### **Issue: "GCP_BILLING_TABLE environment variable not set"**

**Solution:**
- Make sure you've set the `GCP_BILLING_TABLE` variable
- Verify the table name matches exactly what's in BigQuery

### **Issue: "Failed to parse GCP_SERVICE_ACCOUNT_KEY as JSON"**

**Solution:**
- The JSON must be valid and on a single line
- Check for missing quotes or commas
- Try re-copying from the original key file

### **Issue: "GCP BigQuery test query failed"**

**Possible causes:**
1. **Billing export not yet active** - Wait 24-48 hours after enabling
2. **Wrong table name** - Verify in BigQuery console
3. **Insufficient permissions** - Ensure service account has required roles
4. **Wrong project ID** - Double-check project ID matches

### **Issue: "No cost data returned"**

**Solution:**
- Billing export takes 24-48 hours to populate
- Verify you have actual GCP usage/costs
- Check the date range in your query

---

## 📊 What Data is Fetched?

The application queries the following from BigQuery:

- **Daily cost breakdown** by service
- **Service names** (e.g., Compute Engine, Cloud Storage)
- **Regions** where resources are deployed
- **Labels/Tags** for cost allocation
- **Date range**: Configurable (default: current month)

---

## 🔐 Security Best Practices

1. **Never commit** `.env` file to version control
2. **Rotate keys** periodically (every 90 days recommended)
3. **Use least privilege** - only grant necessary permissions
4. **Monitor usage** - Check service account activity regularly
5. **Delete unused keys** - Remove old keys from GCP Console

---

## 📚 Additional Resources

- [GCP Billing Export Documentation](https://cloud.google.com/billing/docs/how-to/export-data-bigquery)
- [BigQuery Billing Schema](https://cloud.google.com/billing/docs/how-to/export-data-bigquery-tables)
- [Service Account Best Practices](https://cloud.google.com/iam/docs/best-practices-service-accounts)

---

## 🆘 Need Help?

If you encounter issues:

1. Check the application logs for detailed error messages
2. Verify your BigQuery billing export is active
3. Test your service account permissions in GCP Console
4. Review the troubleshooting section above

---

## ✨ Success!

Once configured, your application will:
- ✅ Fetch real-time GCP cost data
- ✅ Display actual spending by service
- ✅ Show cost trends and anomalies
- ✅ Generate accurate forecasts
- ✅ Support multi-cloud cost analysis (AWS + GCP + Azure)

Enjoy your real-time GCP cost insights! 🎉
