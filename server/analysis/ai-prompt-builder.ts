/**
 * AI Prompt Builder
 * Creates structured prompts for OpenAI with service-specific guidance
 */

export function buildFinOpsPrompt(data: any, savings: any): string {
  return `You are a senior AWS FinOps architect analyzing cloud cost data.

Service: ${data.service}
Total Monthly Cost: $${data.totalCost.toFixed(2)}

Service Type Guidance:
${getServiceGuidance(data.service)}

Cost Breakdown (Top Usage Types):
${formatCostBreakdown(data.costBreakdown)}

Infrastructure Details:
${JSON.stringify(data.infrastructure, null, 2)}

Calculated Savings Potential:
- Estimated Amount: $${savings.estimatedSavingsAmount}
- Estimated Percent: ${savings.estimatedSavingsPercent}%
- Breakdown: ${savings.breakdown.join(', ')}

Purchase Model:
- On-Demand: ${data.purchaseModel.onDemandPercent.toFixed(1)}%
- Reserved/Savings Plan: ${data.purchaseModel.reservedPercent.toFixed(1)}%

Your tasks:
1. Identify top 3 cost drivers from highest cost breakdown items
2. Explain root cause clearly and technically
3. Identify measurable inefficiencies with specific metrics
4. Recommend concrete, actionable optimization steps
5. Validate and refine the savings estimation (adjust if needed)
6. Assign risk level based on implementation complexity
7. Provide confidence score based on data completeness

CRITICAL RULES:
- Use ONLY the provided data
- Do NOT hallucinate AWS resources or metrics
- If data is insufficient, clearly state limitations
- Be specific with numbers and percentages
- Output STRICTLY valid JSON

Output format (JSON only, no markdown):
{
  "rootCause": "Clear technical explanation of why costs are high",
  "topDrivers": ["Driver 1", "Driver 2", "Driver 3"],
  "inefficiencies": ["Specific inefficiency with metrics"],
  "recommendations": ["Actionable recommendation with expected impact"],
  "validatedSavingsAmount": "$XX.XX",
  "validatedSavingsPercent": "XX.X%",
  "riskLevel": "LOW|MEDIUM|HIGH",
  "confidenceScore": 0-100
}`;
}

function getServiceGuidance(service: string): string {
  const guidance: Record<string, string> = {
    "Amazon Elastic Compute Cloud - Compute": 
      "Evaluate CPU/memory utilization, instance sizing, Reserved/Savings Plan coverage, and auto-scaling configuration.",
    "Amazon SageMaker": 
      "Evaluate training job duration, endpoint sizing, instance utilization, and idle endpoint detection.",
    "Amazon Relational Database Service": 
      "Evaluate instance class, Multi-AZ configuration, Reserved Instance coverage, and connection pooling.",
    "Amazon Simple Storage Service": 
      "Evaluate storage tiering, lifecycle policies, object size distribution, and Intelligent-Tiering adoption.",
    "AWS Lambda":
      "Evaluate memory allocation, execution duration, cold starts, and provisioned concurrency usage.",
    "Amazon DynamoDB":
      "Evaluate capacity mode (on-demand vs provisioned), auto-scaling configuration, and table design.",
  };
  
  return guidance[service] || "Evaluate usage patterns, resource sizing, and cost optimization opportunities.";
}

function formatCostBreakdown(breakdown: Record<string, any>): string {
  const entries = Object.entries(breakdown)
    .map(([usageType, regions]: [string, any]) => {
      const totalCost = Object.values(regions).reduce((sum: number, r: any) => sum + r.cost, 0);
      return { usageType, totalCost };
    })
    .sort((a, b) => b.totalCost - a.totalCost)
    .slice(0, 10); // Top 10

  return entries
    .map(e => `- ${e.usageType}: $${e.totalCost.toFixed(2)}`)
    .join('\n') || 'No detailed breakdown available';
}
