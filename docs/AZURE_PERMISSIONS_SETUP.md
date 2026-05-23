# Azure Permissions Setup Guide

## Issue
Azure authentication is successful, but Cost Management API returns 403 Forbidden error:
```
The client does not have authorization to perform action 'Microsoft.CostManagement/Query/read'
```

## Solution
The Azure service principal needs the **Cost Management Reader** role assigned at the subscription level.

## Steps to Fix

### Option 1: Using Azure Portal (Recommended)

1. **Navigate to your Subscription**
   - Go to [Azure Portal](https://portal.azure.com)
   - Search for "Subscriptions" in the top search bar
   - Click on your subscription: `2210324a-184b-416a-ba57-aeaca8dd383d`

2. **Open Access Control (IAM)**
   - In the left sidebar, click **Access control (IAM)**

3. **Add Role Assignment**
   - Click **+ Add** → **Add role assignment**
   - In the **Role** tab:
     - Search for "Cost Management Reader"
     - Select **Cost Management Reader**
     - Click **Next**

4. **Assign to Service Principal**
   - In the **Members** tab:
     - Select **User, group, or service principal**
     - Click **+ Select members**
     - Search for your service principal by Client ID: `6d28a5c6-779b-44af-a9a0-fe90f4c35ba9`
     - Or search by the app registration name
     - Select it and click **Select**
     - Click **Next**

5. **Review and Assign**
   - Review the settings
   - Click **Review + assign**
   - Wait for the assignment to complete (may take a few minutes)

### Option 2: Using Azure CLI

```bash
# Login to Azure
az login

# Set the subscription
az account set --subscription "2210324a-184b-416a-ba57-aeaca8dd383d"

# Assign Cost Management Reader role
az role assignment create \
  --assignee "6d28a5c6-779b-44af-a9a0-fe90f4c35ba9" \
  --role "Cost Management Reader" \
  --scope "/subscriptions/2210324a-184b-416a-ba57-aeaca8dd383d"
```

### Option 3: Using PowerShell

```powershell
# Connect to Azure
Connect-AzAccount

# Set the subscription context
Set-AzContext -SubscriptionId "2210324a-184b-416a-ba57-aeaca8dd383d"

# Assign the role
New-AzRoleAssignment `
  -ObjectId "26012739-3f32-4138-8570-1e9a544776aa" `
  -RoleDefinitionName "Cost Management Reader" `
  -Scope "/subscriptions/2210324a-184b-416a-ba57-aeaca8dd383d"
```

## Required Permissions

The service principal needs one of these roles:

### Minimum (Recommended):
- **Cost Management Reader** - Read-only access to cost data

### Alternative Options:
- **Cost Management Contributor** - Read and write access to cost data
- **Reader** - Read-only access to all resources (includes cost data)
- **Contributor** - Full access (not recommended for cost monitoring only)

## Verification

After assigning the role, wait 5-10 minutes for permissions to propagate, then test:

### Using the Test Script:
```bash
node test-azure-auth.cjs
```

You should see:
```
✅ Access token obtained successfully!
✅ Cost Management API working!
   Rows returned: X
```

### Using the Application:
1. Restart your server
2. Navigate to the dashboard
3. Azure should show as "CONFIGURED ✓"
4. Cost data should appear

## Troubleshooting

### Permission Still Not Working?
1. **Wait longer** - Azure permissions can take up to 30 minutes to propagate
2. **Clear token cache** - Restart your application server
3. **Verify role assignment**:
   ```bash
   az role assignment list --assignee "6d28a5c6-779b-44af-a9a0-fe90f4c35ba9" --scope "/subscriptions/2210324a-184b-416a-ba57-aeaca8dd383d"
   ```

### Wrong Subscription?
Make sure you're assigning the role to the correct subscription where you want to monitor costs.

### Service Principal Not Found?
- Verify the Client ID is correct
- Make sure the App Registration exists in your Azure AD tenant
- Check if the service principal was created (it's created automatically when you assign a role)

## Additional Resources

- [Azure Cost Management Documentation](https://docs.microsoft.com/en-us/azure/cost-management-billing/)
- [Azure RBAC Documentation](https://docs.microsoft.com/en-us/azure/role-based-access-control/)
- [Cost Management Reader Role](https://docs.microsoft.com/en-us/azure/role-based-access-control/built-in-roles#cost-management-reader)

## Summary

**Your Azure credentials are correct and authentication is working!** ✅

You just need to assign the **Cost Management Reader** role to your service principal at the subscription level. Once that's done, Azure cost data will start flowing into your dashboard.
