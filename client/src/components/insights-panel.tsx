import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle, TrendingUp, Calendar, Activity } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";

interface InsightsPanelProps {
  peakDay?: {
    date: string;
    cost: number;
  };
  topServicePercentage?: number;
  serviceCount?: number;
  anomalies?: Array<{
    date: string;
    type: string;
    cost: number;

    totalDelta: number;
    rootCause: string;
    serviceImpact: number;
    contributionPercent: number;

    severity: 'Low' | 'Medium' | 'High' | 'Critical';
    confidenceScore: number;

    recommendation: string;
  }>;

  loading?: boolean;
}

export function InsightsPanel({ peakDay, topServicePercentage, serviceCount, anomalies = [], loading }: InsightsPanelProps) {
  console.log("anomalies ", anomalies)

  const now = new Date();

  const currentMonthAnomalies = anomalies.filter((anomaly) => {
    const anomalyDate = new Date(anomaly.date);
    return (
      anomalyDate.getMonth() === now.getMonth() &&
      anomalyDate.getFullYear() === now.getFullYear()
    );
  });

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-32" />
        </CardHeader>
        <CardContent className="space-y-4">
          {[...Array(3)].map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'high': return 'destructive';
      case 'medium': return 'default';
      case 'low': return 'secondary';
      default: return 'secondary';
    }
  };

  const getSeverityBorder = (severity: string) => {
  switch (severity) {
    case 'Critical':
      return 'border-red-500';
    case 'High':
      return 'border-orange-500';
    case 'Medium':
      return 'border-yellow-500';
    case 'Low':
      return 'border-green-500';
    default:
      return 'border-gray-300';
  }
};

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg font-semibold flex items-center gap-2">
          <Activity className="h-5 w-5 text-primary" />
          Cost Insights
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4" data-testid="panel-insights">
        {peakDay && (
          <div className="p-4 rounded-lg bg-primary/5 border border-primary/20">
            <div className="flex items-center gap-2 mb-2">
              <Calendar className="h-4 w-4 text-primary" />
              <p className="text-sm font-medium">Peak Spending Day</p>
            </div>
            <p className="text-2xl font-bold tabular-nums text-primary" data-testid="text-peak-day-cost">
              ${peakDay.cost.toFixed(2)}
            </p>
            <p className="text-xs text-muted-foreground mt-1" data-testid="text-peak-day-date">{peakDay.date}</p>
          </div>
        )}

        {topServicePercentage !== undefined && (
          <div className="p-4 rounded-lg bg-chart-2/5 border border-chart-2/20">
            <div className="flex items-center gap-2 mb-2">
              <TrendingUp className="h-4 w-4 text-chart-2" />
              <p className="text-sm font-medium">Top Service Share</p>
            </div>
            <p className="text-2xl font-bold tabular-nums text-chart-2" data-testid="text-top-service-percentage">
              {topServicePercentage.toFixed(1)}%
            </p>
            <p className="text-xs text-muted-foreground mt-1">of total cost</p>
          </div>
        )}

        {serviceCount !== undefined && (
          <div className="p-4 rounded-lg bg-muted/50">
            <p className="text-sm font-medium text-muted-foreground mb-1">Active Services</p>
            <p className="text-2xl font-bold tabular-nums" data-testid="text-service-diversity">{serviceCount}</p>
            <p className="text-xs text-muted-foreground mt-1">service diversity</p>
          </div>
        )}

        {currentMonthAnomalies?.slice(0, 3).map((anomaly, index) => {
            const confidencePercent = anomaly.confidenceScore
              ? (anomaly.confidenceScore * 100).toFixed(0)
              : "0";

            const severityColor = getSeverityBorder(anomaly.severity);

            const confidenceLabel =
              Number(confidencePercent) >= 60
                ? "High"
                : Number(confidencePercent) >= 30
                ? "Moderate"
                : "Low";

            return (
              <div
                key={index}
                className={`border-l-4 ${severityColor} bg-muted/50 shadow-sm rounded-md p-5 space-y-4`}
              >
                {/* Header */}
                <div>
                  <p className="text-sm font-bold uppercase tracking-wide">
                    🚨 {anomaly.severity} Severity — {anomaly.type.toUpperCase()}
                  </p>
                  <p className="text-sm text-muted-foreground mt-1">
                    {new Date(anomaly.date).toLocaleDateString()}
                  </p>
                </div>

                {/* Financial Impact */}
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">
                    Financial Impact
                  </p>
                  <p className="text-xl font-semibold mt-1">
                    {anomaly.totalDelta < 0 ? "↓" : "↑"} $
                    {Math.abs(anomaly.totalDelta).toFixed(2)}{" "}
                    <span className="text-sm font-normal text-muted-foreground">
                      (vs previous day)
                    </span>
                  </p>
                </div>

                {/* Primary Driver */}
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">
                    Primary Driver
                  </p>
                  <p className="font-medium mt-1">{anomaly.rootCause || "N/A"}</p>
                  <p className="text-sm text-muted-foreground">
                    {anomaly.serviceImpact < 0 ? "↓" : "↑"} $
                    {Math.abs(anomaly.serviceImpact || 0).toFixed(2)} (
                    {anomaly.contributionPercent || 0}% of total change)
                  </p>
                </div>

                {/* AI Assessment */}
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">
                    AI Assessment
                  </p>
                  <p className="text-sm mt-1">
                    {confidenceLabel} anomaly confidence ({confidencePercent}%)
                  </p>
                </div>

                {/* Recommendation */}
                <div className="bg-muted/50 p-3 rounded-md">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">
                    Recommendation
                  </p>
                  <p className="text-sm mt-1">{anomaly.recommendation}</p>
                </div>
              </div>
            );
          })}



      </CardContent>
    </Card>
  );
}
