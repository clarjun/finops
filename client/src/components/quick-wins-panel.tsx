import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Zap, TrendingDown, AlertTriangle, Server, ArrowRight } from "lucide-react";
import { useLocation } from "wouter";

interface OptimizationRecommendation {
  id: number;
  type: string;
  priority: string;
  potentialSavings: number | string;
  resourceName?: string;
  currentCost?: number | string;
  optimizedCost?: number | string;
  description: string;
}

interface QuickWinsPanelProps {
  recommendations?: OptimizationRecommendation[];
  loading?: boolean;
}

export function QuickWinsPanel({ recommendations = [], loading }: QuickWinsPanelProps) {
  const [, setLocation] = useLocation();

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-32" />
        </CardHeader>
        <CardContent className="space-y-4">
          {[...Array(3)].map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }

  const getTypeIcon = (type: string) => {
    switch (type) {
      case 'right_sizing':
        return <TrendingDown className="h-4 w-4" />;
      case 'idle_resource':
        return <AlertTriangle className="h-4 w-4" />;
      case 'reserved_instance':
        return <Server className="h-4 w-4" />;
      default:
        return <Zap className="h-4 w-4" />;
    }
  };

  const getTypeLabel = (type: string) => {
    switch (type) {
      case 'right_sizing':
        return 'Rightsizing';
      case 'idle_resource':
        return 'Idle Resource';
      case 'reserved_instance':
        return 'Reserved Instance';
      case 'spot_instance':
        return 'Spot Instance';
      default:
        return type.replace(/_/g, ' ');
    }
  };

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'critical':
        return 'destructive';
      case 'high':
        return 'default';
      case 'medium':
        return 'secondary';
      case 'low':
        return 'outline';
      default:
        return 'secondary';
    }
  };

  // Get top 3 recommendations by priority and savings
  const topRecommendations = [...recommendations]
    .sort((a, b) => {
      const priorityWeight = { critical: 4, high: 3, medium: 2, low: 1 };
      const aPriority = priorityWeight[a.priority as keyof typeof priorityWeight] || 0;
      const bPriority = priorityWeight[b.priority as keyof typeof priorityWeight] || 0;
      
      if (aPriority !== bPriority) return bPriority - aPriority;
      
      const aSavings = typeof a.potentialSavings === 'string' 
        ? parseFloat(a.potentialSavings) 
        : a.potentialSavings;
      const bSavings = typeof b.potentialSavings === 'string' 
        ? parseFloat(b.potentialSavings) 
        : b.potentialSavings;
      
      return bSavings - aSavings;
    })
    .slice(0, 3);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg font-semibold flex items-center gap-2">
          <Zap className="h-5 w-5 text-primary" />
          Quick Wins
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Top cost optimization opportunities
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {topRecommendations.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <Zap className="h-12 w-12 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No optimization recommendations available</p>
            <p className="text-xs mt-1">Your costs are already optimized!</p>
          </div>
        ) : (
          topRecommendations.map((rec) => {
            const savings = typeof rec.potentialSavings === 'string' 
              ? parseFloat(rec.potentialSavings) 
              : rec.potentialSavings;

            return (
              <div
                key={rec.id}
                className="p-3 rounded-lg border bg-card hover-elevate cursor-pointer transition-all"
                onClick={() => setLocation('/optimization')}
                data-testid={`quick-win-${rec.id}`}
              >
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <div className="flex-shrink-0">
                      {getTypeIcon(rec.type)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">
                        {rec.resourceName || rec.description}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {getTypeLabel(rec.type)}
                      </p>
                    </div>
                  </div>
                  <Badge variant={getPriorityColor(rec.priority)} className="flex-shrink-0">
                    {rec.priority}
                  </Badge>
                </div>
                <div className="flex items-center justify-between">
                  <div className="text-sm">
                    <span className="text-muted-foreground">Save: </span>
                    <span className="font-semibold text-chart-2">
                      ${savings.toFixed(2)}/mo
                    </span>
                  </div>
                </div>
              </div>
            );
          })
        )}
        
        {topRecommendations.length > 0 && (
          <Button
            variant="outline"
            className="w-full"
            onClick={() => setLocation('/optimization')}
            data-testid="button-view-all-recommendations"
          >
            View All Recommendations
            <ArrowRight className="h-4 w-4 ml-2" />
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
