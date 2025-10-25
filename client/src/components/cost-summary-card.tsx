import { Card } from "@/components/ui/card";
import { LucideIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface CostSummaryCardProps {
  title: string;
  value: string;
  icon: LucideIcon;
  trend?: {
    value: string;
    isPositive: boolean;
  };
  loading?: boolean;
  variant?: 'blue' | 'green' | 'purple' | 'orange';
}

const cardVariants = {
  blue: {
    light: "bg-gradient-to-br from-blue-50 to-cyan-50 dark:from-card dark:to-card border-blue-200 dark:border-border",
    iconBg: "bg-blue-100 dark:bg-primary/10",
    iconColor: "text-blue-600 dark:text-primary",
  },
  green: {
    light: "bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-card dark:to-card border-emerald-200 dark:border-border",
    iconBg: "bg-emerald-100 dark:bg-chart-2/10",
    iconColor: "text-emerald-600 dark:text-chart-2",
  },
  purple: {
    light: "bg-gradient-to-br from-purple-50 to-violet-50 dark:from-card dark:to-card border-purple-200 dark:border-border",
    iconBg: "bg-purple-100 dark:bg-purple-500/10",
    iconColor: "text-purple-600 dark:text-purple-400",
  },
  orange: {
    light: "bg-gradient-to-br from-orange-50 to-amber-50 dark:from-card dark:to-card border-orange-200 dark:border-border",
    iconBg: "bg-orange-100 dark:bg-chart-3/10",
    iconColor: "text-orange-600 dark:text-chart-3",
  },
};

export function CostSummaryCard({ title, value, icon: Icon, trend, loading, variant = 'blue' }: CostSummaryCardProps) {
  const variantStyles = cardVariants[variant];

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
    <Card className={cn("p-6 hover-elevate", variantStyles.light)} data-testid={`card-${title.toLowerCase().replace(/\s+/g, '-')}`}>
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <p className="text-sm font-medium text-muted-foreground mb-1">{title}</p>
          <div className="flex items-baseline gap-3">
            <h3 className="text-3xl font-bold tracking-tight tabular-nums" data-testid={`value-${title.toLowerCase().replace(/\s+/g, '-')}`}>
              {value}
            </h3>
            {trend && (
              <span
                className={`text-xs font-medium tabular-nums ${
                  trend.isPositive ? "text-chart-2" : "text-destructive"
                }`}
                data-testid={`trend-${title.toLowerCase().replace(/\s+/g, '-')}`}
              >
                {trend.isPositive ? "↓" : "↑"} {trend.value}
              </span>
            )}
          </div>
        </div>
        <div className={cn("flex h-12 w-12 items-center justify-center rounded-lg", variantStyles.iconBg)}>
          <Icon className={cn("h-6 w-6", variantStyles.iconColor)} />
        </div>
      </div>
    </Card>
  );
}
