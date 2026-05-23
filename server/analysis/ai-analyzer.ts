/**
 * AI Analyzer
 * Integrates with OpenAI API for intelligent cost analysis
 */

import { buildFinOpsPrompt } from "./ai-prompt-builder";
import { AIInsights } from "./types";

export async function analyzeWithLLM(data: any, savings: any): Promise<AIInsights> {
  try {
    // Check if OpenAI is configured
    if (!process.env.OPENAI_API_KEY) {
      console.log('[AI Analyzer] OpenAI not configured, returning fallback insights');
      return generateFallbackInsights(data, savings);
    }

    const OpenAI = (await import("openai")).default;
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    const prompt = buildFinOpsPrompt(data, savings);
    
    console.log('[AI Analyzer] Sending request to OpenAI...');
    
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { 
          role: "system", 
          content: "You are a cloud financial intelligence AI specializing in AWS cost optimization. Always respond with valid JSON only." 
        },
        { role: "user", content: prompt }
      ],
      temperature: 0.2, // Low temperature for consistent, factual responses
      response_format: { type: "json_object" }, // Ensure JSON output
    });

    const content = completion.choices[0].message.content;
    if (!content) {
      throw new Error("OpenAI returned empty response");
    }

    console.log('[AI Analyzer] ✓ Received AI insights');
    return JSON.parse(content) as AIInsights;
    
  } catch (error: any) {
    console.error('[AI Analyzer] Error:', error.message);
    return generateFallbackInsights(data, savings);
  }
}

/**
 * Generate fallback insights when OpenAI is unavailable
 */
function generateFallbackInsights(data: any, savings: any): AIInsights {
  const topDrivers: string[] = [];
  const inefficiencies: string[] = [];
  const recommendations: string[] = [];
  
  // Analyze cost breakdown
  const costEntries = Object.entries(data.costBreakdown || {})
    .map(([usageType, regions]: [string, any]) => {
      const totalCost = Object.values(regions).reduce((sum: number, r: any) => sum + r.cost, 0);
      return { usageType, totalCost };
    })
    .sort((a, b) => b.totalCost - a.totalCost)
    .slice(0, 3);
  
  costEntries.forEach(e => topDrivers.push(`${e.usageType}: $${e.totalCost.toFixed(2)}`));
  
  // Analyze purchase model
  if (data.purchaseModel.onDemandPercent > 80) {
    inefficiencies.push(`${data.purchaseModel.onDemandPercent.toFixed(0)}% On-Demand usage without commitment discounts`);
    recommendations.push("Purchase Savings Plan or Reserved Instances for predictable workloads");
  }
  
  // Analyze resources
  if (data.infrastructure?.resources) {
    const idleCount = data.infrastructure.resources.filter((r: any) => 
      r.utilization?.cpu && r.utilization.cpu < 10
    ).length;
    
    if (idleCount > 0) {
      inefficiencies.push(`${idleCount} resources with CPU utilization below 10%`);
      recommendations.push("Right-size or terminate idle resources");
    }
  }
  
  const rootCause = topDrivers.length > 0
    ? `Primary cost driver is ${topDrivers[0]} with high On-Demand usage`
    : "Insufficient data for detailed analysis";
  
  return {
    rootCause,
    topDrivers: topDrivers.length > 0 ? topDrivers : ["Insufficient data"],
    inefficiencies: inefficiencies.length > 0 ? inefficiencies : ["No major inefficiencies detected"],
    recommendations: recommendations.length > 0 ? recommendations : ["Monitor usage patterns for optimization opportunities"],
    validatedSavingsAmount: `$${savings.estimatedSavingsAmount.toFixed(2)}`,
    validatedSavingsPercent: `${savings.estimatedSavingsPercent.toFixed(1)}%`,
    riskLevel: "MEDIUM",
    confidenceScore: 60,
  };
}
