/**
 * Query Intent Analyzer
 * Analyzes user queries to determine what resources and actions they're asking about
 */

export interface QueryIntent {
  resourceTypes: string[]; // ['storage', 'compute', 'network', 'database']
  action: string; // 'list', 'analyze', 'find-orphaned', 'find-idle', 'find-unused'
  provider: 'aws' | 'azure' | 'gcp' | 'all';
  filters?: {
    state?: string;
    attached?: boolean;
    utilized?: boolean;
    age?: number; // days
  };
  needsResourceData: boolean;
}

/**
 * Analyze a user query to determine intent
 */
export function analyzeQuery(query: string): QueryIntent {
  const queryLower = query.toLowerCase();
  
  // Detect provider
  const hasAws = queryLower.includes('aws') || queryLower.includes('amazon') || queryLower.includes('ec2') || queryLower.includes('ebs') || queryLower.includes('s3');
  const hasGcp = queryLower.includes('gcp') || queryLower.includes('google');
  const hasAzure = queryLower.includes('azure') || queryLower.includes('microsoft');
  const providerCount = [hasAws, hasGcp, hasAzure].filter(Boolean).length;
  
  let provider: 'aws' | 'azure' | 'gcp' | 'all' = 'all';
  if (providerCount === 1) {
    if (hasAws) provider = 'aws';
    else if (hasGcp) provider = 'gcp';
    else if (hasAzure) provider = 'azure';
  }
  
  // Detect resource types
  const resourceTypes: string[] = [];
  
  // Storage keywords
  if (queryLower.match(/\b(storage|volume|disk|bucket|snapshot|ebs|s3|blob)\b/)) {
    resourceTypes.push('storage');
  }
  
  // Compute keywords
  if (queryLower.match(/\b(instance|vm|virtual machine|ec2|compute|server)\b/)) {
    resourceTypes.push('compute');
  }
  
  // Network keywords
  if (queryLower.match(/\b(network|ip|elastic ip|load balancer|vpc|subnet)\b/)) {
    resourceTypes.push('network');
  }
  
  // Database keywords
  if (queryLower.match(/\b(database|rds|sql|mysql|postgres|dynamodb)\b/)) {
    resourceTypes.push('database');
  }
  
  // Detect action
  let action = 'analyze';
  const filters: QueryIntent['filters'] = {};
  
  // Check for specific actions first (orphaned, idle) before generic list/show
  if (queryLower.match(/\b(orphan|unattached|detached|not attached)\b/)) {
    action = 'find-orphaned';
    filters.attached = false;
  } else if (queryLower.match(/\b(idle|underutilized|low utilization|not used|inactive|waste|wasting)\b/)) {
    action = 'find-idle';
    filters.utilized = false;
  } else if (queryLower.match(/\bunused\b/)) {
    // "unused" could mean orphaned or idle, check context
    if (queryLower.match(/\b(storage|volume|disk|bucket)\b/)) {
      action = 'find-orphaned';
      filters.attached = false;
    } else {
      action = 'find-idle';
      filters.utilized = false;
    }
  } else if (queryLower.match(/\b(list|show|display|get|find)\b/)) {
    action = 'list';
  }
  
  // Detect age filters
  const ageMatch = queryLower.match(/(\d+)\s*(day|week|month)/);
  if (ageMatch) {
    const value = parseInt(ageMatch[1]);
    const unit = ageMatch[2];
    if (unit === 'day') filters.age = value;
    else if (unit === 'week') filters.age = value * 7;
    else if (unit === 'month') filters.age = value * 30;
  }
  
  // Determine if we need resource data (not just cost data)
  const needsResourceData = 
    resourceTypes.length > 0 || 
    action === 'find-orphaned' || 
    action === 'find-idle' ||
    queryLower.match(/\b(orphan|unattached|idle|underutilized|unused|waste)\b/) !== null;
  
  return {
    resourceTypes: resourceTypes.length > 0 ? resourceTypes : ['general'],
    action,
    provider,
    filters: Object.keys(filters).length > 0 ? filters : undefined,
    needsResourceData,
  };
}

/**
 * Get a human-readable description of the intent
 */
export function describeIntent(intent: QueryIntent): string {
  const parts: string[] = [];
  
  parts.push(`Action: ${intent.action}`);
  parts.push(`Resources: ${intent.resourceTypes.join(', ')}`);
  parts.push(`Provider: ${intent.provider}`);
  
  if (intent.filters) {
    const filterDesc: string[] = [];
    if (intent.filters.attached === false) filterDesc.push('unattached');
    if (intent.filters.utilized === false) filterDesc.push('underutilized');
    if (intent.filters.age) filterDesc.push(`older than ${intent.filters.age} days`);
    if (filterDesc.length > 0) {
      parts.push(`Filters: ${filterDesc.join(', ')}`);
    }
  }
  
  parts.push(`Needs resource data: ${intent.needsResourceData ? 'yes' : 'no'}`);
  
  return parts.join(' | ');
}
