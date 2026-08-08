/**
 * Provider service name -> FOCUS ServiceCategory.
 *
 * Without this, "compare our compute spend across clouds" is unanswerable: AWS
 * calls it "Amazon Elastic Compute Cloud - Compute", Azure "Virtual Machines",
 * GCP "Compute Engine". Categorizing at ingestion means the comparison is a
 * GROUP BY rather than three hard-coded service-name lists in the UI.
 *
 * Matching is substring-based and case-insensitive because providers rename
 * services and append qualifiers ("- Compute", "(EU West)") without warning.
 * Order matters: the first matching rule wins, so put specific terms above
 * generic ones ("sql database" before "database").
 */
import type { ServiceCategory } from "@shared/schema";

interface Rule {
  match: string[];
  category: ServiceCategory;
}

const RULES: Rule[] = [
  // AI / ML — before compute, since several names contain "instance"/"engine".
  // 'machine learning' must not precede the IAM check below: AWS calls IAM
  // "Identity and Access Management", which contains neither 'iam' nor 'ml'.
  { category: 'AI and Machine Learning', match: [
    'sagemaker', 'bedrock', 'comprehend', 'rekognition', 'textract', 'polly', 'lex',
    'cognitive', 'openai', 'machine learning', 'vertex ai', 'vertex', 'dialogflow',
    'translation', 'speech', 'vision ai', 'automl', 'notebooks',
    'gemini', 'anthropic', 'generative', 'kiro',
  ]},

  // Databases — before storage, since several are described as storage.
  { category: 'Databases', match: [
    'rds', 'relational database', 'aurora', 'dynamodb', 'documentdb', 'elasticache',
    'memorydb', 'neptune', 'timestream', 'redshift', 'keyspaces',
    'sql database', 'sql managed', 'cosmos', 'database for mysql', 'database for postgresql',
    'cache for redis', 'cloud sql', 'firestore', 'bigtable', 'spanner', 'datastore', 'memorystore',
  ]},

  { category: 'Analytics', match: [
    'athena', 'emr', 'glue', 'kinesis', 'quicksight', 'data pipeline', 'lake formation', 'msk',
    'opensearch', 'elasticsearch',
    'synapse', 'data factory', 'databricks', 'stream analytics', 'event hubs', 'hdinsight',
    'bigquery', 'dataflow', 'dataproc', 'pub/sub', 'pubsub', 'looker', 'data catalog',
  ]},

  // Security before Compute: "AWS Directory Service" would otherwise be caught
  // by a compute term, and identity services are a security concern.
  { category: 'Security', match: [
    'guardduty', 'security hub', 'security command', 'inspector', 'macie', 'waf', 'shield',
    'kms', 'key management', 'secrets manager', 'secret manager',
    'certificate manager', 'cognito', 'iam', 'identity and access', 'directory service',
    'firewall', 'verified access', 'private ca',
    'sentinel', 'defender', 'key vault', 'active directory', 'security center',
    'cloud armor', 'identity platform', 'binary authorization',
  ]},

  { category: 'Compute', match: [
    'elastic compute', 'ec2', 'lambda', 'fargate', 'batch', 'lightsail', 'elastic beanstalk',
    // AWS spells these out in billing data: "Amazon Elastic Container Service
    // for Kubernetes" contains neither 'eks' nor 'ecs'.
    'container service', 'kubernetes', 'ecs', 'eks', 'outposts', 'app runner',
    'virtual machines', 'virtual machine', 'container instances',
    'app service', 'functions', 'batch account', 'service fabric',
    'compute engine', 'cloud run', 'app engine',
  ]},

  { category: 'Storage', match: [
    's3', 'simple storage', 'ebs', 'elastic block', 'efs', 'elastic file system',
    'fsx', 'glacier', 'storage gateway', 'backup', 'snowball',
    'storage account', 'blob', 'managed disks', 'disks', 'files', 'data lake storage',
    'cloud storage', 'filestore', 'persistent disk', 'archive',
  ]},

  { category: 'Networking', match: [
    'cloudfront', 'route 53', 'route53', 'vpc', 'virtual private cloud',
    'direct connect', 'elastic load balancing',
    'load balancer', 'global accelerator', 'transit gateway', 'nat gateway', 'api gateway',
    'privatelink', 'cloud map',
    'virtual network', 'expressroute', 'application gateway', 'front door', 'traffic manager',
    'bandwidth', 'dns', 'cdn',
    'cloud cdn', 'cloud dns', 'cloud nat', 'cloud interconnect', 'network',
  ]},

  { category: 'Management and Governance', match: [
    'cloudwatch', 'cloudtrail', 'config', 'systems manager', 'organizations', 'control tower',
    'trusted advisor', 'service catalog', 'cloudformation', 'support',
    'cost explorer', 'billing', 'budgets', 'resource explorer',
    'monitor', 'log analytics', 'automation', 'policy', 'advisor', 'cost management',
    'operations', 'logging', 'monitoring', 'cloud deployment',
  ]},

  { category: 'Developer Tools', match: [
    'codebuild', 'codepipeline', 'codecommit', 'codedeploy', 'codeartifact', 'cloud9', 'x-ray',
    'devops', 'pipelines', 'container registry', 'artifact registry', 'cloud build',
    'source repositories',
  ]},

  { category: 'Web', match: [
    'amplify', 'appsync', 'static web', 'web pubsub', 'firebase', 'workspaces',
  ]},
];

const cache = new Map<string, ServiceCategory>();

export function categorizeService(serviceName: string | null | undefined): ServiceCategory {
  if (!serviceName) return 'Other';

  const cached = cache.get(serviceName);
  if (cached) return cached;

  const needle = serviceName.toLowerCase();
  let result: ServiceCategory = 'Other';

  outer: for (const rule of RULES) {
    for (const term of rule.match) {
      if (needle.includes(term)) {
        result = rule.category;
        break outer;
      }
    }
  }

  cache.set(serviceName, result);
  return result;
}
