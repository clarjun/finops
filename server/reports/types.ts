/**
 * FinOps Report Types
 * Type definitions for comprehensive cost reporting
 */

export interface CloudSpendOverview {
  totalSpendMTD: number;
  forecastMonthEnd: number;
  budget?: number; // Optional - only for single-month ranges
  potentialSavings?: number; // Optional - only for single-month ranges
  budgetUtilization?: number; // percentage - only for single-month ranges
  daysIntoMonth: number;
  daysInMonth: number;
  budgetUnavailableReason?: string; // Reason why budget is not shown
  budgetBasis?: string; // How the budget figure was derived (e.g. "monthly AWS budget × 3 months")
}

export interface TopCostDriver {
  service: string;
  cost: number;
  percentage: number;
  trend: 'up' | 'down' | 'stable';
  changePercent: number;
}

export interface ExpensiveResource {
  resourceId: string;
  resourceName: string;
  service: string;
  cost: number;
  region: string;
  owner?: string;
}

export interface CostTrendDataPoint {
  month: string;
  cost: number;
  forecast?: number;
}

export interface AnomalyAlert {
  date: string;
  service: string;
  type: 'spike' | 'drop' | 'unusual';
  changePercent: number;
  previousCost: number;
  currentCost: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

export interface WasteDetection {
  idleInstances: number;
  unattachedDisks: number;
  lowCpuVMs: number;
  potentialSaving: number;
  details: {
    idleResources: Array<{
      resourceId: string;
      type: string;
      cost: number;
      reason: string;
    }>;
    underutilizedResources: Array<{
      resourceId: string;
      type: string;
      cost: number;
      utilization: number;
      recommendation: string;
    }>;
  };
}

export interface ResourceUtilization {
  resourceId: string;
  resourceName: string;
  service: string;
  cost: number;
  utilization: number; // 0-100
  size: string;
  recommendation: string;
}

export interface OptimizationOpportunity {
  category: string;
  description: string;
  monthlySavings: number;
  effort: 'low' | 'medium' | 'high';
  impact: 'low' | 'medium' | 'high';
  resources: number;
}

export interface DepartmentAllocation {
  department: string;
  cost: number;
  percentage: number;
  resourceCount: number;
  topServices: Array<{
    service: string;
    cost: number;
  }>;
}

export interface CostAllocationHeatmapData {
  services: string[];
  departments: string[];
  data: number[][]; // 2D array: [service][department] = cost
}

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

export interface FinOpsReport {
  provider: 'aws' | 'azure' | 'gcp';
  generatedAt: string;
  dateRange: {
    start: string;
    end: string;
  };
  spendOverview: CloudSpendOverview;
  topCostDrivers: TopCostDriver[];
  expensiveResources: ExpensiveResource[];
  costTrend: CostTrendDataPoint[];
  anomalies: AnomalyAlert[];
  wasteDetection: WasteDetection;
  utilizationData: ResourceUtilization[];
  optimizationOpportunities: OptimizationOpportunity[];
  departmentAllocation: DepartmentAllocation[];
  heatmapData: CostAllocationHeatmapData;
  aiSpendAnalysis: AISpendAnalysis;
}
