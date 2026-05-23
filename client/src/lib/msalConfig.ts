// src/msalConfig.js
import { PublicClientApplication } from "@azure/msal-browser";

// These are public MSAL config values (client-side only — no secret here)
// clientSecret must NEVER be in frontend code — it belongs server-side only
const clientId = import.meta.env.VITE_AZURE_CLIENT_ID || "";
const tenantId = import.meta.env.VITE_AZURE_TENANT_ID || "";
const redirectUri = import.meta.env.VITE_AZURE_REDIRECT_URI || window.location.origin;

// Scope for Azure Resource Manager (Cost Management) - delegated permission added in App Registration
//const ARM_SCOPE = "https://management.azure.com/user_impersonation"
const ARM_SCOPE = "https://management.azure.com/.default";

export const msalConfig = {
  auth: {
    clientId,
    authority: `https://login.microsoftonline.com/${tenantId}`,
    redirectUri
  },
  cache: {
    cacheLocation: "localStorage",
    storeAuthStateInCookie: false
  }
};

export const loginRequest = {
  scopes: [ARM_SCOPE, "openid", "profile", "offline_access"]
};

export const tokenRequest = {
  scopes: [ARM_SCOPE]
};

export const msalInstance = new PublicClientApplication(msalConfig);
