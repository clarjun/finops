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
    cost: number;
    service?: string;
    type: string;
    severity: 'low' | 'medium' | 'high';
    description: string;
  }>;
  loading?: boolean;
}

export function InsightsPanel({ peakDay, topServicePercentage, serviceCount, anomalies = [], loading }: InsightsPanelProps) {
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

        {anomalies.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-semibold flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-chart-3" />
              Anomalies Detected
            </p>
            {anomalies.slice(0, 3).map((anomaly, index) => (
              <Alert key={index} className="py-3" data-testid={`alert-anomaly-${index}`}>
                <AlertDescription className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{anomaly.description}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {anomaly.date} {anomaly.service && `• ${anomaly.service}`}
                    </p>
                  </div>
                  <Badge variant={getSeverityColor(anomaly.severity)} className="shrink-0">
                    {anomaly.severity}
                  </Badge>
                </AlertDescription>
              </Alert>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
