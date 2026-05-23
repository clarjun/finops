/**
 * Service Analyzer Router
 * Routes to appropriate analyzer based on service name and provider
 */

import { genericAnalyzer } from './analyzers/generic-analyzer';
import { azureAnalyzer } from './analyzers/azure-analyzer';

export async function analyzeService(
  service: string,
  startDate: string,
  endDate: string,
  provider: 'aws' | 'azure' | 'gcp' = 'aws'
) {
  console.log(`[Service Router] Routing analysis for: ${service} (${provider})`);
  
  // Route to provider-specific analyzer
  if (provider === 'azure') {
    return azureAnalyzer(service, startDate, endDate);
  }
  
  if (provider === 'gcp') {
    // GCP analyzer to be implemented
    return genericAnalyzer(service, startDate, endDate);
  }
  
  // AWS - use generic analyzer or specific ones
  switch (service) {
    case "Amazon Elastic Compute Cloud - Compute":
      // return analyzeEC2(startDate, endDate);
      return genericAnalyzer(service, startDate, endDate);
      
    case "Amazon SageMaker":
      // return analyzeSageMaker(startDate, endDate);
      return genericAnalyzer(service, startDate, endDate);
      
    case "Amazon Relational Database Service":
      // return analyzeRDS(startDate, endDate);
      return genericAnalyzer(service, startDate, endDate);
      
    case "Amazon Simple Storage Service":
      // return analyzeS3(startDate, endDate);
      return genericAnalyzer(service, startDate, endDate);
      
    default:
      return genericAnalyzer(service, startDate, endDate);
  }
}
