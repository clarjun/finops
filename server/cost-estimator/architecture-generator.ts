/**
 * AI-Powered Architecture Generator
 * Uses OpenAI to analyze requirements and suggest optimal cloud architecture
 */

import { openai } from "../openai-client";

/** One service on the estimate, with the sizing the pricing engine needs. */
export interface ArchitectureItem {
  layer: string;
  service: string;
  configuration?: string;

  storageSize?: number;
  dataTransfer?: number;
  memoryMb?: number;
  durationMs?: number;
  instanceType?: string;
  instanceCount?: number;
  /**
   * This service's own request volume. Usually the application total, but not
   * always — a queue may see a fraction of it. Priced per service so a line can
   * differ without every other line moving with it.
   */
  monthlyRequests?: number;
  provisionedConcurrency?: number;

  /**
   * required    the application cannot reasonably run without it
   * recommended a strong operational recommendation, not strictly needed
   * optional    a useful upgrade
   */
  necessity?: Necessity;

  justification?: string;
}

export type Necessity = 'required' | 'recommended' | 'optional';

/** Retained so existing callers keep compiling; the item shape is the same. */
export type ArchitectureLayer = ArchitectureItem;

/** Where a figure came from, which is the difference between a fact and a guess. */
export type AssumptionSource = 'user_provided' | 'inferred' | 'calculated' | string;

export interface UsageAssumptions {
  dailyActiveUsers?: number;
  requestsPerUserPerDay?: number;
  monthlyRequests?: number;
  assumptionSources?: {
    dailyActiveUsers?: AssumptionSource;
    requestsPerUserPerDay?: AssumptionSource;
    monthlyRequests?: AssumptionSource;
  };
  notes?: string;
}

export interface ApplicationProfile {
  type?: string;
  trafficClass?: string;
  availability?: string;
}

export interface ArchitectureResult {
  applicationProfile: ApplicationProfile;
  assumptions: UsageAssumptions;
  /** The shape of the system before any AWS service is named. */
  logicalArchitecture: string[];
  architecture: ArchitectureItem[];
  reasoning: string;
}

/** The old name, kept so nothing downstream has to change at once. */
export type ArchitectureRecommendation = ArchitectureResult;

const ARCHITECTURE_PROMPT = `
You are a senior AWS solutions architect designing a right-sized cloud
architecture and producing inputs for a cost estimation engine.

Your job is NOT to maximize infrastructure.

Your job is to determine the SMALLEST PRACTICAL AWS architecture that can
safely satisfy the user's stated requirements.

Return ONLY valid JSON.

==================================================
CORE PRINCIPLE
==================================================

Every AWS service has:

1. Cost
2. Operational complexity
3. Security implications
4. Deployment complexity

Therefore:

DO NOT add infrastructure unless the requirements justify it.

Prefer:
- managed services
- serverless where appropriate
- fewer components
- low idle cost
- simple architecture
- automatic scaling
- minimal operational overhead

==================================================
IMPORTANT: DO NOT COPY SERVICES FROM EXAMPLES
==================================================

Any examples in this prompt are illustrative only.

Never add a service merely because it appears in an example.

A service must be independently justified by the user's requirements.

==================================================
1. UNDERSTAND THE REQUIREMENT
==================================================

Extract:

- application type
- daily users
- monthly users if inferable
- traffic
- requests
- data size
- storage requirements
- availability
- latency requirements
- growth expectations
- authentication
- file uploads
- real-time requirements
- compliance
- geographic requirements
- environment

If information is missing, make conservative assumptions.

Never pretend an inferred value was provided by the user.

==================================================
2. LOAD ASSUMPTIONS
==================================================

If the user gives daily users, use that exact number.

If request volume is not provided:

Estimate:

requestsPerUserPerDay

using the application type.

For a generic simple CRUD application, use 20 requests/user/day.

Clearly mark this as INFERRED.

Calculate:

monthlyRequests =
dailyActiveUsers × requestsPerUserPerDay × 30

Never independently invent request volume for different services.

ALL request-priced services must use the SAME monthly request assumption.

Example:

500 users/day
× 20 requests/user/day
× 30 days
=
300,000 requests/month

==================================================
3. APPLICATION PROFILE
==================================================

Classify the application:

- simple_web_application
- crud_application
- ecommerce
- content_application
- api_application
- data_application
- real_time_application
- other

Also classify:

trafficClass:
- low
- medium
- high

availability:
- standard
- high
- mission_critical

==================================================
4. ARCHITECTURE SELECTION
==================================================

First determine the logical architecture.

Example:

Frontend
Backend API
Database
Object Storage
Monitoring

Then map the logical architecture to AWS services.

==================================================
5. SERVICE SELECTION RULES
==================================================

Lambda:

Use for lightweight APIs and event-driven workloads.

Provide:

memoryMb
durationMs
monthlyRequests

Do NOT add provisioned concurrency unless consistently low latency is
explicitly required.

--------------------------------------------------

API Gateway:

Use when the backend is an HTTP API exposed through API Gateway.

Use the SAME monthlyRequests from assumptions.

--------------------------------------------------

DynamoDB:

Prefer when:

- simple CRUD
- key/value or document data
- serverless application
- no complex joins
- no complex relational reporting

--------------------------------------------------

RDS PostgreSQL:

Prefer when:

- relational data
- joins
- transactions
- complex queries
- reporting
- ecommerce/accounting/business systems

Provide:

storageSize
instanceType
instanceCount

--------------------------------------------------

S3:

Use for:

- static frontend
- uploaded files
- images
- documents
- object storage

Provide:

storageSize
dataTransfer

--------------------------------------------------

CloudFront:

Do NOT add by default.

Add only when:

- CDN is explicitly requested
- global users
- high static asset traffic
- low-latency global delivery is required

--------------------------------------------------

WAF:

Do NOT add by default.

For simple/low traffic applications, WAF should normally be omitted.

Only add it when:

- security requirements justify it
- public attack surface requires it
- compliance requires it
- user explicitly requests WAF

If optional, do NOT include it in the architecture by default.

--------------------------------------------------

ALB:

Do NOT add when Lambda + API Gateway is sufficient.

Use only when EC2/ECS or another load-balanced architecture requires it.

--------------------------------------------------

ElastiCache:

Do NOT add unless caching requirements are explicitly stated.

--------------------------------------------------

SQS/SNS:

Do NOT add unless asynchronous processing, decoupling, queues,
notifications, or event-driven processing is required.

--------------------------------------------------

EKS:

Do NOT recommend EKS for a simple low-traffic application.

Only use when Kubernetes requirements are explicitly stated.

--------------------------------------------------

Multi-AZ:

Do NOT enable automatically.

Only use when:

- high availability is required
- production SLA requires it
- user explicitly requests it

==================================================
6. REQUIRED VS RECOMMENDED VS OPTIONAL
==================================================

Use:

necessity:
"required"
"recommended"
"optional"

Required:
Application cannot reasonably operate without it.

Recommended:
Strong operational recommendation but not strictly required.

Optional:
Useful upgrade but not necessary.

Do NOT include optional infrastructure simply to increase the estimate.

==================================================
7. COST ESTIMATION INPUTS
==================================================

The model does NOT calculate AWS prices.

The model only provides resource configuration and usage assumptions.

The application will calculate actual pricing separately.

For each service provide only the parameters required by the pricing engine.

Use EXACT field names:

storageSize
dataTransfer
memoryMb
durationMs
instanceType
instanceCount
monthlyRequests

==================================================
8. RESOURCE SIZING
==================================================

Use realistic but conservative values.

Do not over-provision.

For a simple application with approximately 500 daily users:

Typical starting point may be:

Lambda:
memoryMb: 512
durationMs: 200

Requests:
~300,000/month if 20 requests/user/day is assumed.

Database:
Use the smallest practical managed configuration.

Storage:
Use only the amount implied by the requirement.

Never invent large storage volumes.

==================================================
9. SECURITY
==================================================

Do not automatically add:

WAF
KMS
NAT Gateway
Firewall
VPN
Multi-region

unless requirements justify them.

Basic IAM/security configuration may be required internally for deployment,
but do not treat every IAM role or security group as an additional customer
architecture service unless the pricing engine requires it.

==================================================
10. DNS
==================================================

Route 53 is optional.

Only include it when:

- custom domain is required
- DNS management is explicitly requested

Do not automatically include Route 53.

==================================================
11. MONITORING
==================================================

CloudWatch is recommended for production applications.

Estimate log volume conservatively.

Do not invent large log volumes.

==================================================
12. ASSUMPTION TRANSPARENCY
==================================================

Every inferred assumption must be clearly marked.

Example:

"dailyActiveUsers": 500,
"requestsPerUserPerDay": 20,
"monthlyRequests": 300000

And:

"assumptionSources": {
  "dailyActiveUsers": "user_provided",
  "requestsPerUserPerDay": "inferred",
  "monthlyRequests": "calculated"
}

==================================================
13. RESPONSE FORMAT
==================================================

Return exactly:

{
  "applicationProfile": {
    "type": "...",
    "trafficClass": "...",
    "availability": "..."
  },

  "assumptions": {
    "dailyActiveUsers": 500,
    "requestsPerUserPerDay": 20,
    "monthlyRequests": 300000,
    "assumptionSources": {
      "dailyActiveUsers": "user_provided",
      "requestsPerUserPerDay": "inferred",
      "monthlyRequests": "calculated"
    },
    "notes": "..."
  },

  "logicalArchitecture": [
    "Frontend",
    "Backend API",
    "Database",
    "Monitoring"
  ],

  "architecture": [
    {
      "layer": "Compute",
      "service": "AWS Lambda",
      "configuration": "Node.js HTTP handlers",
      "memoryMb": 512,
      "durationMs": 200,
      "monthlyRequests": 300000,
      "necessity": "required",
      "justification": "Provides serverless backend compute for the application."
    }
  ],

  "reasoning": "Brief explanation of why these services were selected and which common services were deliberately excluded."
}

==================================================
14. FINAL VALIDATION BEFORE RESPONSE
==================================================

Before returning JSON, verify:

1. Every service has a requirement-based justification.
2. No service was added merely because it appeared in this prompt.
3. No WAF unless justified.
4. No CDN unless justified.
5. No cache unless justified.
6. No queue unless justified.
7. No multi-AZ unless justified.
8. No EKS for simple low traffic.
9. All request-priced services use the same monthlyRequests.
10. All inferred assumptions are marked inferred.
11. No actual AWS prices are invented.
12. Architecture is minimal and practical.
13. JSON is valid.
`;

export async function generateArchitecture(requirements: string): Promise<ArchitectureResult> {
  try {
    console.log('[Architecture Generator] Analyzing requirements...');
    console.log('[Architecture Generator] Requirements length:', requirements.length);

    const completion = await openai.chat.completions.create({
      model: 'gpt-5',
      messages: [
        { role: 'system', content: ARCHITECTURE_PROMPT },
        { role: 'user', content: requirements },
      ],
      response_format: { type: 'json_object' },
      // GPT-5 spends tokens on reasoning before it writes anything, so a limit
      // sized for the answer alone returns an empty response rather than an
      // error.
      max_completion_tokens: 8000,
    });

    const choice = completion.choices?.[0];
    if (!choice) throw new Error('No completion choice returned');

    console.log('[Architecture Generator] Finish reason:', choice.finish_reason);
    console.log('[Architecture Generator] Token usage:', JSON.stringify(completion.usage));

    const response = choice.message?.content;
    if (!response) {
      throw new Error(
        'The model returned an empty response. With GPT-5 this usually means the token limit was reached during reasoning.',
      );
    }

    const parsed = JSON.parse(response) as Partial<ArchitectureResult>;

    // Two things the estimate genuinely cannot be built without.
    if (!Array.isArray(parsed.architecture) || parsed.architecture.length === 0) {
      throw new Error('Invalid response: architecture must be a non-empty array');
    }
    if (!parsed.assumptions) {
      throw new Error('Invalid response: assumptions missing, so no request-priced service could be costed');
    }

    // These two describe the answer rather than produce it. Throwing away a
    // whole estimate over a missing label would be a worse outcome than
    // recording that the label was missing, so they degrade instead.
    if (!parsed.applicationProfile) {
      console.warn('[Architecture Generator] No applicationProfile returned; continuing without it.');
    }
    if (!Array.isArray(parsed.logicalArchitecture)) {
      console.warn('[Architecture Generator] No logicalArchitecture returned; continuing without it.');
    }

    const result: ArchitectureResult = {
      applicationProfile: parsed.applicationProfile ?? {},
      assumptions: parsed.assumptions,
      logicalArchitecture: Array.isArray(parsed.logicalArchitecture) ? parsed.logicalArchitecture : [],
      architecture: parsed.architecture,
      reasoning: parsed.reasoning ?? '',
    };

    const byNecessity = result.architecture.reduce<Record<string, number>>((acc, item) => {
      const key = item.necessity ?? 'unspecified';
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});

    console.log(
      '[Architecture Generator] Generated', result.architecture.length, 'services',
      JSON.stringify(byNecessity),
    );

    return result;
  } catch (error) {
    console.error('[Architecture Generator] Error:', error);

    if (error instanceof Error) {
      throw new Error(`Failed to generate architecture: ${error.message}`);
    }
    throw new Error('Failed to generate architecture recommendation');
  }
}
