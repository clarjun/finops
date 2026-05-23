import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, TrendingDown, AlertTriangle, Lightbulb, DollarSign, Server } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";

interface ServiceAnalysisModalProps {
  open: boolean;
  onClose: () => void;
  serviceName: string;
  analysisData: any;
  isLoading: boolean;
}

export function ServiceAnalysisModal({
  open,
  onClose,
  serviceName,
  analysisData,
  isLoading,
}: ServiceAnalysisModalProps) {
  if (isLoading) {
    return (
      <Dialog open={open} onOpenChange={onClose}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Analyzing Service</DialogTitle>
            <DialogDescription>
              Please wait while we analyze {serviceName}...
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-center p-8">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <span className="ml-3 text-lg">Analyzing {serviceName}...</span>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  if (!analysisData) return null;

  const { totalCost, savings, aiInsights, purchaseModel, userAttribution } = analysisData;

  const getRiskColor = (risk: string) => {
    switch (risk) {
      case 'LOW': return 'default';
      case 'MEDIUM': return 'secondary';
      case 'HIGH': return 'destructive';
      default: return 'outline';
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-5xl max-h-[90vh]">
        <DialogHeader>
          <DialogTitle className="text-2xl">{serviceName}</DialogTitle>
          <DialogDescription>
            Comprehensive cost analysis with AI-powered insights and optimization recommendations
          </DialogDescription>
          <div className="flex items-center gap-4 mt-2">
            <div className="text-sm text-muted-foreground">
              Monthly Cost: <span className="font-semibold text-foreground">${totalCost.toFixed(2)}</span>
            </div>
            <div className="text-sm text-muted-foreground">
              On-Demand: <span className="font-semibold text-foreground">{purchaseModel.onDemandPercent.toFixed(0)}%</span>
            </div>
          </div>
        </DialogHeader>

        <ScrollArea className="max-h-[calc(90vh-120px)] pr-4">
          <div className="space-y-4">
            {/* Savings Summary */}
            <Card className="border-green-200 bg-green-50 dark:bg-green-950 dark:border-green-800">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-green-700 dark:text-green-300">
                  <DollarSign className="h-5 w-5" />
                  Potential Savings
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-4xl font-bold text-green-600 dark:text-green-400 mb-4">
                  ${savings.estimatedSavingsAmount.toFixed(2)}
                  <span className="text-xl ml-2">({savings.estimatedSavingsPercent.toFixed(1)}%)</span>
                </div>
                {savings.breakdown && savings.breakdown.length > 0 && (
                  <ul className="space-y-2">
                    {savings.breakdown.map((reason: string, idx: number) => (
                      <li key={idx} className="text-sm flex items-start gap-2">
                        <TrendingDown className="h-4 w-4 mt-0.5 flex-shrink-0 text-green-600" />
                        <span>{reason}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            {/* AI Insights */}
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>AI Analysis</CardTitle>
                  <div className="flex gap-2">
                    <Badge variant={getRiskColor(aiInsights.riskLevel)}>
                      {aiInsights.riskLevel} Risk
                    </Badge>
                    <Badge variant="outline">
                      {aiInsights.confidenceScore}% Confidence
                    </Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Root Cause */}
                <div>
                  <h4 className="font-semibold flex items-center gap-2 mb-2">
                    <AlertTriangle className="h-4 w-4 text-orange-500" />
                    Root Cause
                  </h4>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {aiInsights.rootCause}
                  </p>
                </div>

                {/* Top Cost Drivers */}
                <div>
                  <h4 className="font-semibold mb-2">Top Cost Drivers</h4>
                  <ul className="space-y-1">
                    {aiInsights.topDrivers.map((driver: string, idx: number) => (
                      <li key={idx} className="text-sm flex items-start gap-2">
                        <span className="text-primary font-medium">{idx + 1}.</span>
                        <span>{driver}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Inefficiencies */}
                <div>
                  <h4 className="font-semibold mb-2">Inefficiencies Detected</h4>
                  <ul className="space-y-1">
                    {aiInsights.inefficiencies.map((issue: string, idx: number) => (
                      <li key={idx} className="text-sm flex items-start gap-2">
                        <span className="text-destructive">•</span>
                        <span>{issue}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Recommendations */}
                <div>
                  <h4 className="font-semibold flex items-center gap-2 mb-2">
                    <Lightbulb className="h-4 w-4 text-yellow-500" />
                    Recommendations
                  </h4>
                  <ul className="space-y-2">
                    {aiInsights.recommendations.map((rec: string, idx: number) => (
                      <li key={idx} className="text-sm flex items-start gap-2 p-2 rounded bg-muted/50">
                        <span className="text-primary font-medium">{idx + 1}.</span>
                        <span>{rec}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Validated Savings */}
                <div className="pt-4 border-t">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">AI Validated Savings:</span>
                    <span className="font-semibold text-lg">
                      {aiInsights.validatedSavingsAmount} ({aiInsights.validatedSavingsPercent})
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* User Attribution (AWS only) */}
            {userAttribution && userAttribution.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Server className="h-5 w-5" />
                    Cost Attribution by Owner
                  </CardTitle>
                  <p className="text-xs text-muted-foreground mt-1">
                    Estimated costs based on resource ownership proportion
                  </p>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {userAttribution.slice(0, 10).map((user: any, idx: number) => (
                      <div key={idx} className="flex items-center justify-between p-3 rounded-lg bg-muted/30 hover:bg-muted/50 transition-colors">
                        <div className="flex-1">
                          <div className="font-medium">{user.owner}</div>
                          <div className="text-xs text-muted-foreground">
                            {user.resourceCount} resource{user.resourceCount !== 1 ? 's' : ''}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="font-semibold text-lg">
                            ${user.totalCost.toFixed(2)}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {((user.totalCost / totalCost) * 100).toFixed(1)}% of total
                          </div>
                        </div>
                      </div>
                    ))}
                    {userAttribution.length > 10 && (
                      <div className="text-center text-sm text-muted-foreground pt-2">
                        + {userAttribution.length - 10} more owners
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
