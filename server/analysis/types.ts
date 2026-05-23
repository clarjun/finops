/**
 * Shared TypeScript interfaces for AI Service Analysis
 */

export interface NormalizedResource {
  id: string;
  type: string;
  region: string;
  configuration: Record<string, any>;
  utilization?: {
    cpu?: number;
    memory?: number;
    network?: number;
    storage?: number;
  };
  estimatedMonthlyCost?: number;
  optimizationSignals?: string[];
}

export interface SavingsResult {
  estimatedSavingsAmount: number;
  estimatedSavingsPercent: number;
  breakdown: string[];
}

export interface AIInsights {
  rootCause: string;
  topDrivers: string[];
  inefficiencies: string[];
  recommendations: string[];
  validatedSavingsAmount: string;
  validatedSavingsPercent: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  confidenceScore: number;
}

export interface FullAnalysisResult {
  service: string;
  totalCost: number;
  costBreakdown: Record<string, any>;
  infrastructure: any;
  purchaseModel: {
    onDemandPercent: number;
    reservedPercent: number;
  };
  savings: SavingsResult;
  aiInsights: AIInsights;
}

export interface ServiceAnalysisRequest {
  service: string;
  startDate: string;
  endDate: string;
  provider?: 'aws' | 'gcp' | 'azure';
}
