import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

interface CostDistributionTableProps {
  data: Array<{
    name: string;
    cost: number;
    percentage: number;
  }>;
  loading?: boolean;
}

export function CostDistributionTable({ data, loading }: CostDistributionTableProps) {
  if (loading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-40" />
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  const getCostLevel = (percentage: number) => {
    if (percentage >= 20) return { color: "bg-destructive/10 text-destructive border-destructive/20", label: "High" };
    if (percentage >= 10) return { color: "bg-chart-3/10 text-chart-3 border-chart-3/20", label: "Medium" };
    return { color: "bg-chart-2/10 text-chart-2 border-chart-2/20", label: "Low" };
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg font-semibold">Cost Distribution</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3" data-testid="list-cost-distribution">
          {data.map((service, index) => {
            const costLevel = getCostLevel(service.percentage);
            return (
              <div
                key={index}
                className="flex items-center justify-between p-4 rounded-lg bg-muted/30 hover-elevate"
                data-testid={`item-service-${service.name.toLowerCase().replace(/\s+/g, '-')}`}
              >
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate" data-testid={`text-service-name-${index}`}>{service.name}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden max-w-xs">
                      <div
                        className="h-full bg-primary transition-all duration-300"
                        style={{ width: `${service.percentage}%` }}
                      />
                    </div>
                    <span className="text-xs text-muted-foreground tabular-nums">{service.percentage.toFixed(1)}%</span>
                  </div>
                </div>
                <div className="flex items-center gap-3 ml-4">
                  <Badge variant="outline" className={costLevel.color}>
                    {costLevel.label}
                  </Badge>
                  <p className="text-lg font-semibold tabular-nums" data-testid={`text-service-cost-${index}`}>
                    ${service.cost.toFixed(2)}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
