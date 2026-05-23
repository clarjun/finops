import { GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import { initializeAWSClient } from "../aws-client";
import type { AWSCostData } from "../aws-client";

// AI service definitions by cloud provider
const AI_SERVICES = {
  aws: [
    'Amazon Bedrock',
    'Amazon SageMaker',
    'Amazon Rekognition',
    'Amazon Comprehend',
    'Amazon Textract',
    'Amazon Kendra',
    'Amazon Transcribe',
    'Amazon Polly',
    'Amazon Translate',
    'Amazon Lex',
    'Amazon Personalize',
    'Amazon Forecast',
    'Amazon Fraud Detector',
    'Amazon CodeWhisperer',
    'AWS DeepLens',
    'AWS DeepRacer',
    'Amazon Augmented AI',
    'Amazon DevOps Guru',
    'Amazon Lookout for Vision',
    'Amazon Lookout for Metrics',
    'Amazon Lookout for Equipment',
    'Amazon Monitron',
    'Amazon HealthLake',
  ],
  azure: [
    'Azure OpenAI Service',
    'Azure Cognitive Services',
    'Azure Machine Learning',
    'Azure Bot Service',
    'Azure Cognitive Search',
    'Azure Form Recognizer',
    'Azure Computer Vision',
    'Azure Face API',
    'Azure Speech Services',
    'Azure Language Understanding',
    'Azure Translator',
    'Azure Content Moderator',
    'Azure Personalizer',
    'Azure Anomaly Detector',
    'Azure Metrics Advisor',
    'Azure Video Indexer',
    'Azure Applied AI Services',
  ],
  gcp: [
    'Vertex AI',
    'Cloud AI Platform',
    'AutoML',
    'Vision AI',
    'Video AI',
    'Natural Language AI',
    'Translation AI',
    'Speech-to-Text',
    'Text-to-Speech',
    'Dialogflow',
    'Document AI',
    'Recommendations AI',
    'Contact Center AI',
    'Talent Solution',
    'Cloud TPU',
    'AI Platform Notebooks',
    'AI Platform Training',
    'AI Platform Prediction',
  ],
};

export interface AIServiceCost {
  service: string;
  cost: number;
  percentage: number;
}

export interface AISpendAnalysis {
  totalAISpend: number;
  aiServices: AIServiceCost[];
  aiPercentageOfTotal: number;
  topAIService: string;
  monthOverMonthChange: number;
}

/**
 * Analyze AI-related costs for AWS
 */
export async function analyzeAWSAICosts(
  accountId: string,
  startDate: string,
  endDate: string
): Promise<AISpendAnalysis> {
  try {
    const costExplorerClient = await initializeAWSClient();
    if (!costExplorerClient) {
      throw new Error('AWS Cost Explorer not available');
    }

    console.log(`[AI Cost Analyzer] Fetching AWS AI costs from ${startDate} to ${endDate}`);

    // Fetch costs grouped by service
    const command = new GetCostAndUsageCommand({
      TimePeriod: {
        Start: startDate,
        End: endDate,
      },
      Granularity: 'MONTHLY',
      Metrics: ['UnblendedCost'],
      GroupBy: [
        {
          Type: 'DIMENSION',
          Key: 'SERVICE',
        },
      ],
    });

    const response = await costExplorerClient.send(command);
    
    // Extract AI service costs
    const aiServiceCosts: { [key: string]: number } = {};
    let totalCost = 0;

    if (response.ResultsByTime) {
      for (const result of response.ResultsByTime) {
        if (result.Groups) {
          for (const group of result.Groups) {
            const serviceName = group.Keys?.[0] || 'Unknown';
            const cost = parseFloat(group.Metrics?.UnblendedCost?.Amount || '0');
            
            totalCost += cost;
            
            // Check if this is an AI service
            if (AI_SERVICES.aws.some(aiService => serviceName.includes(aiService))) {
              aiServiceCosts[serviceName] = (aiServiceCosts[serviceName] || 0) + cost;
            }
          }
        }
      }
    }

    // Calculate total AI spend
    const totalAISpend = Object.values(aiServiceCosts).reduce((sum, cost) => sum + cost, 0);

    // Create sorted array of AI services
    const aiServices: AIServiceCost[] = Object.entries(aiServiceCosts)
      .map(([service, cost]) => ({
        service: cleanServiceName(service),
        cost,
        percentage: totalAISpend > 0 ? (cost / totalAISpend) * 100 : 0,
      }))
      .sort((a, b) => b.cost - a.cost);

    // Find top AI service
    const topAIService = aiServices.length > 0 ? aiServices[0].service : 'None';

    // Calculate AI percentage of total
    const aiPercentageOfTotal = totalCost > 0 ? (totalAISpend / totalCost) * 100 : 0;

    console.log(`[AI Cost Analyzer] AWS AI spend: $${totalAISpend.toFixed(2)} (${aiPercentageOfTotal.toFixed(1)}% of total)`);
    console.log(`[AI Cost Analyzer] Found ${aiServices.length} AI services`);

    return {
      totalAISpend,
      aiServices,
      aiPercentageOfTotal,
      topAIService,
      monthOverMonthChange: 0, // TODO: Calculate MoM change
    };
  } catch (error) {
    console.error('[AI Cost Analyzer] Error analyzing AWS AI costs:', error);
    return {
      totalAISpend: 0,
      aiServices: [],
      aiPercentageOfTotal: 0,
      topAIService: 'None',
      monthOverMonthChange: 0,
    };
  }
}

/**
 * Analyze AI-related costs for Azure
 */
export async function analyzeAzureAICosts(
  accountId: string,
  startDate: string,
  endDate: string
): Promise<AISpendAnalysis> {
  try {
    console.log(`[AI Cost Analyzer] Fetching Azure AI costs from ${startDate} to ${endDate}`);

    // Azure implementation would use Cost Management API
    // For now, return empty data
    // TODO: Implement Azure AI cost analysis using Cost Management API

    return {
      totalAISpend: 0,
      aiServices: [],
      aiPercentageOfTotal: 0,
      topAIService: 'None',
      monthOverMonthChange: 0,
    };
  } catch (error) {
    console.error('[AI Cost Analyzer] Error analyzing Azure AI costs:', error);
    return {
      totalAISpend: 0,
      aiServices: [],
      aiPercentageOfTotal: 0,
      topAIService: 'None',
      monthOverMonthChange: 0,
    };
  }
}

/**
 * Analyze AI-related costs for GCP
 */
export async function analyzeGCPAICosts(
  accountId: string,
  startDate: string,
  endDate: string
): Promise<AISpendAnalysis> {
  try {
    console.log(`[AI Cost Analyzer] Fetching GCP AI costs from ${startDate} to ${endDate}`);

    // GCP implementation would use BigQuery billing export
    // For now, return empty data
    // TODO: Implement GCP AI cost analysis using BigQuery

    return {
      totalAISpend: 0,
      aiServices: [],
      aiPercentageOfTotal: 0,
      topAIService: 'None',
      monthOverMonthChange: 0,
    };
  } catch (error) {
    console.error('[AI Cost Analyzer] Error analyzing GCP AI costs:', error);
    return {
      totalAISpend: 0,
      aiServices: [],
      aiPercentageOfTotal: 0,
      topAIService: 'None',
      monthOverMonthChange: 0,
    };
  }
}

/**
 * Clean up service names for display
 */
function cleanServiceName(serviceName: string): string {
  // Remove "Amazon" or "AWS" prefix
  return serviceName
    .replace(/^Amazon\s+/i, '')
    .replace(/^AWS\s+/i, '')
    .replace(/^Azure\s+/i, '')
    .trim();
}

/**
 * Main function to analyze AI costs based on provider
 */
export async function analyzeAICosts(
  provider: 'aws' | 'azure' | 'gcp',
  accountId: string,
  startDate: string,
  endDate: string
): Promise<AISpendAnalysis> {
  switch (provider) {
    case 'aws':
      return analyzeAWSAICosts(accountId, startDate, endDate);
    case 'azure':
      return analyzeAzureAICosts(accountId, startDate, endDate);
    case 'gcp':
      return analyzeGCPAICosts(accountId, startDate, endDate);
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}
