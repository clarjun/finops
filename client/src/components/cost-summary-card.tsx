import { Card } from "@/components/ui/card";
import { LucideIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

interface CostSummaryCardProps {
  title: string;
  value: string;
  icon: LucideIcon;
  trend?: {
    value: string;
    isPositive: boolean;
  };
  loading?: boolean;
}

export function CostSummaryCard({ title, value, icon: Icon, trend, loading }: CostSummaryCardProps) {
  if (loading) {
    return (
      <Card className="p-6">
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <Skeleton className="h-4 w-24 mb-3" />
            <Skeleton className="h-8 w-32" />
          </div>
          <Skeleton className="h-10 w-10 rounded-lg" />
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-6 hover-elevate" data-testid={`card-${title.toLowerCase().replace(/\s+/g, '-')}`}>
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <p className="text-sm font-medium text-muted-foreground mb-1">{title}</p>
          <div className="flex items-baseline gap-3">
            <h3 className="text-3xl font-bold tracking-tight tabular-nums text-primary" data-testid={`value-${title.toLowerCase().replace(/\s+/g, '-')}`}>
              {value}
            </h3>
            {trend && (
              <span
                className={`text-xs font-medium tabular-nums ${
                  trend.isPositive ? "text-chart-2" : "text-destructive"
                }`}
                data-testid={`trend-${title.toLowerCase().replace(/\s+/g, '-')}`}
              >
                {trend.isPositive ? "↑" : "↓"} {trend.value}
              </span>
            )}
          </div>
        </div>
        <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
          <Icon className="h-6 w-6 text-primary" />
        </div>
      </div>
    </Card>
  );
}
