/**
 * AWS Resource Tagging Service
 * Fetches Owner tags from AWS resources for a specific service
 */

import { 
  ResourceGroupsTaggingAPIClient, 
  GetResourcesCommand 
} from "@aws-sdk/client-resource-groups-tagging-api";
import { getProviderCredentials } from "../cloud-config-manager";

export interface ResourceOwner {
  resourceArn: string;
  resourceType: string;
  owner: string;
  tags: Record<string, string>;
}

export async function getResourceOwnersByService(
  serviceName: string
): Promise<ResourceOwner[]> {
  try {
    // Get AWS credentials from database
    const accountConfig = await getProviderCredentials('aws');
    
    if (!accountConfig) {
      console.log('[Tagging Service] AWS not configured');
      return [];
    }

    const credentials = accountConfig.credentials;
    
    const taggingClient = new ResourceGroupsTaggingAPIClient({
      region: credentials.region || "us-east-1",
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
      },
    });

    console.log(`[Tagging Service] Fetching resource owners for ${serviceName}`);

    const resources: ResourceOwner[] = [];
    let paginationToken: string | undefined;
    let totalFetched = 0;

    // Map service names to AWS resource type prefixes
    const serviceTypeMap: Record<string, string[]> = {
      "Amazon Elastic Compute Cloud - Compute": ["ec2:instance", "ec2:volume"],
      "Amazon SageMaker": ["sagemaker"],
      "Amazon Relational Database Service": ["rds"],
      "Amazon Simple Storage Service": ["s3"],
      "AWS Lambda": ["lambda"],
      "Amazon DynamoDB": ["dynamodb"],
    };

    const resourceTypes = serviceTypeMap[serviceName];

    do {
      const command = new GetResourcesCommand({
        ResourcesPerPage: 100,
        PaginationToken: paginationToken,
        ResourceTypeFilters: resourceTypes, // Filter by service type if available
      });

      const response = await taggingClient.send(command);
      totalFetched += response.ResourceTagMappingList?.length || 0;

      for (const resource of response.ResourceTagMappingList || []) {
        const arn = resource.ResourceARN;
        if (!arn) continue;

        // Extract resource type from ARN (e.g., arn:aws:ec2:region:account:instance/i-123)
        const arnParts = arn.split(':');
        const resourceType = arnParts[2] || 'unknown';

        // Build tags map
        const tagsMap: Record<string, string> = {};
        let owner = "Unassigned";

        for (const tag of resource.Tags || []) {
          if (tag.Key && tag.Value) {
            tagsMap[tag.Key] = tag.Value;
            
            // Look for Owner tag (case-insensitive)
            if (tag.Key.toLowerCase() === 'owner') {
              owner = tag.Value;
            }
          }
        }

        resources.push({
          resourceArn: arn,
          resourceType,
          owner,
          tags: tagsMap,
        });
      }

      paginationToken = response.PaginationToken;
    } while (paginationToken);

    console.log(`[Tagging Service] ✓ Fetched ${totalFetched} resources, found ${resources.filter(r => r.owner !== 'Unassigned').length} with owners`);
    
    return resources;
    
  } catch (error: any) {
    console.error('[Tagging Service] Error:', error.message);
    return [];
  }
}
