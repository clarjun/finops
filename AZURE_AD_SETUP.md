# Azure AD Authentication Setup Guide

This guide will walk you through setting up Microsoft Azure AD (Active Directory) authentication for your Azure Cost Analysis Dashboard.

## Why Azure AD?

Azure AD provides:
- **Single Sign-On (SSO)** - Users can sign in with their Microsoft accounts
- **Enterprise Security** - OAuth 2.0 and OpenID Connect standards
- **Easy Management** - Centralized user access control
- **Multi-factor Authentication** - Enhanced security options

## Prerequisites

- An Azure subscription or Microsoft 365 account
- Admin access to Azure Portal
- The dashboard application running locally or on Replit

## Step-by-Step Setup

### 1. Access Azure Portal

1. Go to [Azure Portal](https://portal.azure.com)
2. Sign in with your Microsoft account
3. Navigate to **Azure Active Directory** (search for it in the top search bar)

### 2. Register a New Application

1. In the left sidebar, click **App registrations**
2. Click **+ New registration**
3. Fill in the application details:
   - **Name**: `Azure Cost Dashboard` (or any name you prefer)
   - **Supported account types**: Choose based on your needs:
     - **Single tenant**: Only users in your organization
     - **Multi-tenant**: Users from any Azure AD organization
     - **Personal Microsoft accounts**: Include consumer accounts
   - **Redirect URI**: 
     - Platform: **Web**
     - URL: `http://localhost:5000/auth/callback` (for local development)
     - For production: `https://yourdomain.com/auth/callback`
4. Click **Register**

### 3. Copy Application Credentials

After registration, you'll see the application overview page:

1. **Copy the Application (client) ID**
   - This is your `AZURE_CLIENT_ID`
   - Example: `12345678-1234-1234-1234-123456789012`

2. **Copy the Directory (tenant) ID**
   - This is your `AZURE_TENANT_ID`
   - Example: `87654321-4321-4321-4321-210987654321`

### 4. Create a Client Secret

1. In the left sidebar, click **Certificates & secrets**
2. Click **+ New client secret**
3. Add a description: `Dashboard Secret`
4. Choose an expiration period (recommendation: 24 months)
5. Click **Add**
6. **IMPORTANT**: Copy the secret **Value** immediately
   - This is your `AZURE_CLIENT_SECRET`
   - You won't be able to see it again!
   - Example: `AbC1234~xYz5678-aBc9012.dEf3456`

### 5. Configure Authentication Settings

1. In the left sidebar, click **Authentication**
2. Under **Implicit grant and hybrid flows**:
   - ✅ Check **ID tokens**
   - ✅ Check **Access tokens**
3. Under **Advanced settings**:
   - Allow public client flows: **No** (default)
4. Click **Save**

### 6. Configure API Permissions (Optional)

The application already has the minimum required permissions. If you need additional Microsoft Graph API access:

1. In the left sidebar, click **API permissions**
2. Click **+ Add a permission**
3. Select **Microsoft Graph**
4. Choose **Delegated permissions**
5. Add permissions as needed (e.g., `User.Read`, `Mail.Send`)
6. Click **Add permissions**
7. Click **Grant admin consent** (if you're an admin)

### 7. Update Application Environment Variables

Now update your `.env` file with the values you copied:

```env
# Azure AD Authentication
AZURE_TENANT_ID=your-tenant-id-here
AZURE_CLIENT_ID=your-client-id-here
AZURE_CLIENT_SECRET=your-client-secret-here
AZURE_REDIRECT_URI=http://localhost:5000/auth/callback
AZURE_CLOUD_INSTANCE=https://login.microsoftonline.com/
APPLICATION_URL=http://localhost:5000
```

### 8. Production Deployment

When deploying to production:

1. **Update Redirect URI**:
   - Go back to Azure Portal → App registrations → Your app
   - Click **Authentication**
   - Under **Redirect URIs**, add: `https://yourdomain.com/auth/callback`
   - Click **Save**

2. **Update Environment Variables**:
   ```env
   AZURE_REDIRECT_URI=https://yourdomain.com/auth/callback
   APPLICATION_URL=https://yourdomain.com
   ```

3. **Enable HTTPS**:
   - Make sure your application runs on HTTPS in production
   - Update `cookie.secure` to `true` in `server/index.ts`

### 9. Test the Authentication

1. Restart your application:
   ```bash
   npm run dev
   ```

2. Open your browser and navigate to `http://localhost:5000`

3. You should be redirected to the login page

4. Click **Sign in with Microsoft**

5. You'll be redirected to Microsoft's login page

6. Sign in with your Microsoft account

7. Grant permissions when prompted

8. You'll be redirected back to the dashboard

🎉 **Success!** You're now authenticated with Azure AD.

## Troubleshooting

### Error: "Invalid redirect URI"
- Make sure the redirect URI in your `.env` matches exactly what's configured in Azure Portal
- Check for trailing slashes
- Verify the protocol (http vs https)

### Error: "Invalid client secret"
- The client secret might have expired
- Create a new client secret in Azure Portal
- Update your `.env` file with the new secret

### Error: "User cannot access this application"
- Check the **Supported account types** in Azure Portal
- Make sure the user's account type is allowed
- For enterprise apps, check user assignment requirements

### Error: "Session expired"
- Sessions expire after 24 hours by default
- Users need to log in again
- This can be configured in `server/index.ts`

### Users Can't See the App
- In Azure Portal, go to **Enterprise applications**
- Find your app
- Go to **Properties**
- Set **User assignment required** to **No** (for testing)
- For production, assign specific users or groups

## Security Best Practices

1. **Never commit secrets to Git**
   - Always use `.env` files
   - Add `.env` to `.gitignore`
   - Use environment variables in production

2. **Rotate secrets regularly**
   - Create new client secrets every 6-12 months
   - Remove old secrets after updating

3. **Use HTTPS in production**
   - Always encrypt traffic
   - Set secure cookie flags

4. **Limit permissions**
   - Only request the Microsoft Graph permissions you need
   - Review permissions regularly

5. **Monitor access**
   - Check Azure AD sign-in logs regularly
   - Set up alerts for suspicious activity

## Multi-Tenant Applications

If you want to allow users from multiple organizations:

1. **Change account type**:
   - Go to **Authentication** in Azure Portal
   - Under **Supported account types**, select **Multitenant**

2. **Handle tenant IDs**:
   - Use `common` instead of specific tenant ID
   - Update `AZURE_TENANT_ID=common` in your `.env`

3. **Admin consent**:
   - Each organization's admin may need to consent
   - Provide a consent URL in your documentation

## Additional Resources

- [Microsoft Identity Platform Documentation](https://docs.microsoft.com/en-us/azure/active-directory/develop/)
- [Azure AD Authentication Best Practices](https://docs.microsoft.com/en-us/azure/active-directory/develop/identity-platform-integration-checklist)
- [Passport Azure AD Documentation](https://github.com/AzureAD/passport-azure-ad)
- [OAuth 2.0 and OpenID Connect](https://docs.microsoft.com/en-us/azure/active-directory/develop/v2-protocols)

## Need Help?

If you encounter issues:
1. Check the server logs for error messages
2. Review the browser console for client-side errors
3. Verify all environment variables are set correctly
4. Ensure your Azure AD app registration is configured properly
5. Check the troubleshooting section above

---

**Note**: This setup is for development and testing. For production deployments, consult with your organization's security team and follow additional security requirements.
