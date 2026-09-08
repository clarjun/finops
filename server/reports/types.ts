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
  /**
   * Mean daily cost over `baselinePeriod` — NOT the previous day.
   *
   * Named `previousCost` before, and rendered as "$45.17 -> $579.80", which
   * states something untrue: it made two consecutive elevated days look like the
   * cost had fallen back to $45 in between. Same value on every finding for a
   * service, because there is one baseline per service.
   */
  baselineCost: number;
  currentCost: number;
  /** The genuine prior day, for an honest day-over-day comparison. */
  previousDayCost?: number;
  /** Window the baseline was measured over, e.g. "2026-08-09 to 2026-08-29". */
  baselinePeriod?: string;
  baselineDays?: number;
  /**
   * Consecutive anomalous days collapsed into this one finding. A sustained
   * shift used to appear as one "spike" per day for the same service.
   */
  sustainedDays?: number;
  sustainedThrough?: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

/**
 * Attachment and power state are read live, so this section describes the
 * account NOW — not the reported period, which cannot be reconstructed because
 * nothing recorded which volumes were unattached last March. The extra fields
 * exist so the UI can say that, instead of leaving a reader to conclude that
 * twelve months of identical-looking waste figures are a historical finding.
 */
export interface WasteDetection {
  idleInstances: number;
  unattachedDisks: number;
  lowCpuVMs: number;
  potentialSaving: number;
  /** When current-state resources were read. Absent if nothing was assessed. */
  asOf?: string;
  /** Only one region is queried; resources elsewhere are not assessed. */
  regionAssessed?: string;
  /** Window used for the CPU utilisation reading — this DOES follow the report. */
  utilizationPeriod?: string;
  /** Running instances metrics were pulled for, and how many were skipped. */
  instancesAssessed?: number;
  instancesNotAssessed?: number;
  /** Set when the assessment could not run — distinct from finding no waste. */
  unavailableReason?: string;
  /** Set when any price fell back to a dated constant. */
  costBasisNote?: string;
  details: {
    idleResources: Array<{
      resourceId: string;
      type: string;
      cost: number;
      reason: string;
      /** How the cost was derived. Previously always a hardcoded guess. */
      costBasis?: 'list-price' | 'estimated';
    }>;
    underutilizedResources: Array<{
      resourceId: string;
      type: string;
      cost: number;
      utilization: number;
      recommendation: string;
      costBasis?: 'list-price' | 'estimated';
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
