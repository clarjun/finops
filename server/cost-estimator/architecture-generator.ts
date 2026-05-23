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
}

export interface ArchitectureRecommendation {
  architecture: ArchitectureLayer[];
  reasoning: string;
}

const ARCHITECTURE_PROMPT = `You are a senior AWS solutions architect. Analyze the application requirements and suggest an optimal, cost-effective AWS architecture.

IMPORTANT: Return ONLY valid JSON, no markdown, no explanations outside the JSON.

Requirements to analyze:
- Application type and purpose
- Expected user load and traffic patterns
- Database requirements
- Storage needs
- Region preferences
- Availability and scalability requirements

Suggest architecture using these AWS services:
- Compute: EC2, Lambda, ECS, EKS
- Database: RDS (PostgreSQL, MySQL), DynamoDB, Aurora
- Storage: S3, EBS, EFS
- Network: CloudFront, ALB, API Gateway
- Cache: ElastiCache (Redis, Memcached)
- Queue: SQS, SNS
- Other: Route53, WAF, etc.

For each service, specify:
- Instance type (e.g., t3.medium, db.t3.small)
- Instance count or capacity
- Storage size in GB
- Data transfer in GB/month

Return JSON in this exact format:
{
  "architecture": [
    {
      "layer": "Frontend",
      "service": "Amazon S3 + CloudFront",
      "configuration": "Static hosting with global CDN",
      "storageSize": 100,
      "dataTransfer": 1000
    },
    {
      "layer": "Backend",
      "service": "Amazon EC2 Auto Scaling",
      "configuration": "Auto-scaling group with load balancer",
      "instanceType": "t3.medium",
      "instanceCount": 2
    },
    {
      "layer": "Database",
      "service": "Amazon RDS PostgreSQL",
      "configuration": "Multi-AZ deployment",
      "instanceType": "db.t3.medium",
      "instanceCount": 1,
      "storageSize": 100
    }
  ],
  "reasoning": "Brief explanation of architecture choices"
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
