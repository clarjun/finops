/**
 * AI-Powered Architecture Generator
 * Uses OpenAI to analyze requirements and suggest optimal cloud architecture
 */

import { openai } from "../openai-client";

export interface ArchitectureLayer {
  layer: string;
  service: string;
  configuration?: string;
  instanceType?: string;
  instanceCount?: number;
  storageSize?: number;
  dataTransfer?: number;
  /** Lambda sizing, so compute is priced from what it will actually run. */
  memoryMb?: number;
  durationMs?: number;
  provisionedConcurrency?: number;
  /** False when the requirement does not call for it; shown as a suggestion. */
  required?: boolean;
  /** Why this service is here, in one line. */
  justification?: string;
}

/**
 * What the request implies about load.
 *
 * Without this nothing about the stated audience reached the pricing, so the
 * same architecture cost the same whether it served fifty people or fifty
 * thousand.
 */
export interface UsageAssumptions {
  dailyActiveUsers?: number;
  requestsPerUserPerDay?: number;
  notes?: string;
}

export interface ArchitectureRecommendation {
  architecture: ArchitectureLayer[];
  reasoning: string;
  assumptions?: UsageAssumptions;
}

const ARCHITECTURE_PROMPT = `You are a senior AWS solutions architect producing a cost estimate.

Return ONLY valid JSON. No markdown, no prose outside the JSON.

## Size the architecture to the request

Include a service only when the stated requirements need it. A small
application does not become a better one by acquiring more infrastructure, and
every service added is real money and real operational burden for whoever runs
it.

Specifically:
- Do NOT add queues, caches, search, CDNs, firewalls or multi-AZ unless the
  requirements imply them. "A simple application" implies none of these.
- Do NOT add performance features that only matter at scale. Provisioned
  concurrency, read replicas and warm pools are wasted spend at low traffic.
- Prefer one service doing a job to two services sharing it.
- If a service is genuinely optional — a sensible upgrade rather than a
  requirement — include it with "required": false and say why in
  "justification". The user can then decide, rather than being quoted for it
  silently.

Mark "required": true only for what the application cannot run without.

## State your load assumptions

Read the expected traffic from the requirements and put it in "assumptions".
If the user gives a user count, use it. If they do not, choose a modest figure
and say so in "notes". These numbers drive the cost of every request-priced
service, so a guess stated plainly is far better than a number invented per
service.

## Size each service from those assumptions

- Lambda: give memoryMb and durationMs. Add provisionedConcurrency ONLY if
  the requirements demand consistently low latency.
- Databases: give storageSize in GB. Give instanceType only for RDS/Aurora.
- Storage and CDN: give storageSize and dataTransfer in GB per month.
- CloudWatch: give storageSize as the log volume ingested per month, in GB.

Use exactly these field names — storageSize, dataTransfer, memoryMb, durationMs,
instanceType, instanceCount. A differently spelled field cannot be priced.
- Compute: give instanceType and instanceCount.

Use realistic figures for the stated audience. Do not pad.

## Available services

Compute: EC2, Lambda, ECS, EKS · Database: RDS, DynamoDB, Aurora ·
Storage: S3, EBS, EFS · Network: CloudFront, ALB, API Gateway, Route 53 ·
Cache: ElastiCache · Messaging: SQS, SNS · Security: WAF · Monitoring: CloudWatch

## Response shape

{
  "assumptions": {
    "dailyActiveUsers": 500,
    "requestsPerUserPerDay": 20,
    "notes": "Taken from the stated 500 daily users; 20 requests each is typical for a simple CRUD application."
  },
  "architecture": [
    {
      "layer": "Compute",
      "service": "AWS Lambda",
      "configuration": "Node.js handlers behind API Gateway",
      "memoryMb": 512,
      "durationMs": 200,
      "required": true,
      "justification": "Runs the application; serverless suits this traffic and has no idle cost."
    },
    {
      "layer": "Storage",
      "service": "Amazon S3",
      "configuration": "Static frontend assets",
      "storageSize": 1,
      "dataTransfer": 6,
      "required": true,
      "justification": "Hosts the web frontend."
    },
    {
      "layer": "Security",
      "service": "AWS WAF",
      "configuration": "Managed common rule set",
      "required": false,
      "justification": "Optional. Adds roughly $8/month; worth it once the application is public and handling accounts."
    }
  ],
  "reasoning": "Brief explanation, including anything deliberately left out."
}`;

export async function generateArchitecture(requirements: string): Promise<ArchitectureRecommendation> {
  try {
    console.log('[Architecture Generator] Analyzing requirements...');
    console.log('[Architecture Generator] Requirements length:', requirements.length);
    
    const completion = await openai.chat.completions.create({
      model: "gpt-5",
      messages: [
        { role: "system", content: ARCHITECTURE_PROMPT },
        { role: "user", content: requirements }
      ],
      response_format: { type: "json_object" },
      max_completion_tokens: 8000, // Increased to account for reasoning tokens + actual output
    });

    console.log('[Architecture Generator] API call completed');
    console.log('[Architecture Generator] Choices:', completion.choices?.length);
    console.log('[Architecture Generator] Finish reason:', completion.choices[0]?.finish_reason);
    console.log('[Architecture Generator] Token usage:', JSON.stringify(completion.usage));
    
    const response = completion.choices[0]?.message?.content;
    
    if (!response) {
      console.error('[Architecture Generator] Empty response from OpenAI');
      console.error('[Architecture Generator] Full completion:', JSON.stringify(completion, null, 2));
      throw new Error("No response from AI - the API returned an empty response. This may be due to token limits.");
    }

    console.log('[Architecture Generator] Response length:', response.length);
    console.log('[Architecture Generator] Response preview:', response.substring(0, 200));

    const result = JSON.parse(response);
    
    if (!result.architecture || !Array.isArray(result.architecture)) {
      throw new Error("Invalid response format - missing architecture array");
    }
    
    console.log('[Architecture Generator] Generated architecture with', result.architecture.length, 'layers');
    
    return result;
  } catch (error) {
    console.error('[Architecture Generator] Error:', error);
    
    if (error instanceof Error) {
      // Preserve the original error message
      throw new Error(`Failed to generate architecture: ${error.message}`);
    }
    
    throw new Error("Failed to generate architecture recommendation");
  }
}
