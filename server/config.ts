/**
 * Application Configuration
 * 
 * PRODUCTION_MODE: When true, the application will ONLY use real cloud data.
 * Sample data fallbacks will be disabled and proper errors will be returned
 * when cloud providers are not configured.
 */

export const config = {
  // Set to true for production deployment (no sample data)
  // Set to false for development (allows sample data fallbacks)
  PRODUCTION_MODE: process.env.NODE_ENV === 'production' || process.env.PRODUCTION_MODE === 'true',
  
  // Require at least one cloud provider to be configured
  REQUIRE_CLOUD_PROVIDER: process.env.PRODUCTION_MODE === 'true',
};

/**
 * Check if we're in production mode
 */
export function isProductionMode(): boolean {
  return config.PRODUCTION_MODE;
}

/**
 * Get error message for unconfigured provider
 */
export function getProviderNotConfiguredError(provider: string): {
  error: string;
  message: string;
  configurationRequired: Record<string, string>;
} {
  const configs: Record<string, Record<string, string>> = {
    aws: {
      AWS_ACCESS_KEY_ID: 'Your AWS Access Key ID',
      AWS_SECRET_ACCESS_KEY: 'Your AWS Secret Access Key',
      AWS_REGION: 'AWS Region (optional, defaults to us-east-1)',
    },
    gcp: {
      GCP_SERVICE_ACCOUNT_KEY: 'GCP Service Account JSON key (as single line)',
      GCP_PROJECT_ID: 'Your GCP Project ID',
      GCP_BILLING_DATASET: 'BigQuery billing dataset name',
      GCP_BILLING_TABLE: 'BigQuery billing table name',
    },
    azure: {
      AZURE_TENANT_ID: 'Your Azure Tenant ID',
      AZURE_CLIENT_ID: 'Your Azure Client ID',
      AZURE_CLIENT_SECRET: 'Your Azure Client Secret',
      AZURE_BILLING_ACCOUNT_ID: 'Your Azure Billing Account ID',
    },
  };

  return {
    error: `${provider.toUpperCase()} not configured`,
    message: `Please configure ${provider.toUpperCase()} credentials to access cost data. In production mode, sample data is not available.`,
    configurationRequired: configs[provider.toLowerCase()] || {},
  };
}

/**
 * Log configuration status
 */
export function logConfigurationStatus(
  aws: boolean,
  gcp: boolean,
  azure: boolean
): void {
  const mode = isProductionMode() ? 'PRODUCTION' : 'DEVELOPMENT';
  console.log(`\n=== Cloud Cost Analyzer - ${mode} MODE ===`);
  console.log(`AWS Cost Explorer: ${aws ? '✓ CONFIGURED' : '✗ NOT CONFIGURED'}`);
  console.log(`GCP BigQuery Billing: ${gcp ? '✓ CONFIGURED' : '✗ NOT CONFIGURED'}`);
  console.log(`Azure Cost Management: ${azure ? '✓ CONFIGURED' : '✗ NOT CONFIGURED'}`);
  
  if (isProductionMode()) {
    console.log(`\n⚠️  PRODUCTION MODE: Sample data is DISABLED`);
    console.log(`   Only real cloud data will be returned.`);
    console.log(`   Unconfigured providers will return errors.\n`);
  } else {
    console.log(`\n💡 DEVELOPMENT MODE: Sample data fallbacks enabled`);
    console.log(`   Unconfigured providers will use sample data.\n`);
  }
  
  const configuredCount = [aws, gcp, azure].filter(Boolean).length;
  if (configuredCount === 0) {
    console.log(`⚠️  WARNING: No cloud providers configured!`);
    if (isProductionMode()) {
      console.log(`   Application will return errors for all cost data requests.`);
    }
  } else {
    console.log(`✓ ${configuredCount} of 3 cloud providers configured`);
  }
  console.log(`=====================================\n`);
}
