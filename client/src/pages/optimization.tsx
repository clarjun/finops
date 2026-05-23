import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useState } from "react";
import { TrendingDown, TrendingUp, AlertTriangle, CheckCircle2, XCircle, Lightbulb } from "lucide-react";
import { queryClient } from "@/lib/queryClient";
import type { OptimizationRecommendation } from "@shared/schema";

export default function OptimizationPage() {
  const [selectedProvider, setSelectedProvider] = useState<string>("all");
  const { toast } = useToast();

  const { data: recommendationsData, isLoading } = useQuery({
    queryKey: ['/api/optimization/recommendations', selectedProvider],
    queryFn: async () => {
      const url = selectedProvider === "all" 
        ? '/api/optimization/recommendations'
        : `/api/optimization/recommendations?provider=${selectedProvider}`;
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to fetch recommendations');
      return await response.json();
    },
  });

  const recommendations = (recommendationsData as { success: boolean; recommendations: OptimizationRecommendation[] })?.recommendations || [];

  const updateStatusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: string }) => {
      const response = await fetch(`/api/optimization/recommendations/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
        credentials: 'include',
      });
      if (!response.ok) throw new Error('Failed to update status');
      return await response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/optimization/recommendations', selectedProvider] });
      toast({
        title: "Status updated",
        description: "Recommendation status has been updated successfully",
      });
    },
    onError: () => {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to update recommendation status",
      });
    },
  });

  const generateRecommendationsMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/optimization/recommendations/generate', {
        method: 'POST',
        credentials: 'include',
      });
      if (!response.ok) throw new Error('Failed to generate recommendations');
      return await response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/optimization/recommendations', selectedProvider] });
      toast({
        title: "Recommendations generated",
        description: "New optimization recommendations have been generated successfully",
      });
    },
    onError: () => {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to generate recommendations",
      });
    },
  });

  const totalSavings = recommendations.reduce((sum, rec) => sum + parseFloat(rec.potentialSavings.toString()), 0);
  const criticalCount = recommendations.filter(r => r.priority === 'critical').length;
  const highCount = recommendations.filter(r => r.priority === 'high').length;

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'critical': return 'destructive';
      case 'high': return 'default';
      case 'medium': return 'secondary';
      case 'low': return 'outline';
      default: return 'secondary';
    }
  };

  const getTypeIcon = (type: string) => {
    switch (type) {
      case 'right_sizing': return <TrendingDown className="h-4 w-4" />;
      case 'idle_resource': return <AlertTriangle className="h-4 w-4" />;
      case 'reserved_instance': return <TrendingUp className="h-4 w-4" />;
      default: return <Lightbulb className="h-4 w-4" />;
    }
  };

  const getTypeName = (type: string) => {
    switch (type) {
      case 'right_sizing': return 'Right-sizing';
      case 'idle_resource': return 'Idle Resource';
      case 'reserved_instance': return 'Reserved Instance';
      case 'savings_plan': return 'Savings Plan';
      case 'spot_instance': return 'Spot Instance';
      default: return type;
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold" data-testid="heading-optimization">Cost Optimization</h1>
          <p className="text-muted-foreground mt-1">
            ML-powered recommendations to reduce cloud spending
          </p>
        </div>
        <div className="flex gap-2">
          <Select value={selectedProvider} onValueChange={setSelectedProvider}>
            <SelectTrigger className="w-48" data-testid="select-provider-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Providers</SelectItem>
              <SelectItem value="aws">AWS Only</SelectItem>
              <SelectItem value="gcp">GCP Only</SelectItem>
              <SelectItem value="azure">Azure Only</SelectItem>
            </SelectContent>
          </Select>
          <Button 
            onClick={() => generateRecommendationsMutation.mutate()}
            disabled={generateRecommendationsMutation.isPending}
          >
            {generateRecommendationsMutation.isPending ? 'Generating...' : 'Generate Recommendations'}
          </Button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Potential Savings</CardDescription>
            <CardTitle className="text-3xl">${totalSavings.toFixed(2)}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">
              {recommendations.length} recommendations
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Critical Priority</CardDescription>
            <CardTitle className="text-3xl text-destructive">{criticalCount}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">
              Requires immediate action
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>High Priority</CardDescription>
            <CardTitle className="text-3xl text-orange-500">{highCount}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">
              Recommended this week
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Recommendations List */}
      <div className="grid gap-4">
        {isLoading ? (
          <Card>
            <CardContent className="p-6">
              <p className="text-center text-muted-foreground">Loading recommendations...</p>
            </CardContent>
          </Card>
        ) : recommendations.length === 0 ? (
          <Card>
            <CardContent className="p-6">
              <p className="text-center text-muted-foreground">No recommendations found</p>
              <p className="text-center text-sm text-muted-foreground mt-2">
                Your infrastructure is optimized or data is being analyzed
              </p>
            </CardContent>
          </Card>
        ) : (
          recommendations.map((rec) => (
            <Card key={rec.id} data-testid={`card-recommendation-${rec.id}`}>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="flex-1 space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <CardTitle className="text-lg flex items-center gap-2">
                        {getTypeIcon(rec.recommendationType)}
                        {getTypeName(rec.recommendationType)}
                      </CardTitle>
                      <Badge variant={getPriorityColor(rec.priority || 'medium')} data-testid={`badge-priority-${rec.id}`}>
                        {rec.priority?.toUpperCase()}
                      </Badge>
                      {rec.provider && (
                        <Badge variant="outline" data-testid={`badge-provider-${rec.id}`}>
                          {rec.provider.toUpperCase()}
                        </Badge>
                      )}
                    </div>
                    <CardDescription className="text-sm">
                      {rec.serviceName} {rec.resourceId && `• ${rec.resourceId}`}
                    </CardDescription>
                  </div>
                  <div className="text-right">
                    <div className="text-2xl font-bold text-green-600">
                      ${parseFloat(rec.potentialSavings.toString()).toFixed(2)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {rec.savingsPercent ? `${parseFloat(rec.savingsPercent.toString()).toFixed(0)}% savings` : 'potential savings'}
                    </div>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <p className="text-sm font-medium mb-1">Description</p>
                  <p className="text-sm text-muted-foreground">{rec.description}</p>
                </div>

                {rec.actionRequired && (
                  <div>
                    <p className="text-sm font-medium mb-1">Action Required</p>
                    <p className="text-sm text-muted-foreground">{rec.actionRequired}</p>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-muted-foreground">Current Cost:</span>
                    <span className="ml-2 font-medium">${parseFloat(rec.currentCost.toString()).toFixed(2)}/mo</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Optimized Cost:</span>
                    <span className="ml-2 font-medium">${parseFloat(rec.optimizedCost.toString()).toFixed(2)}/mo</span>
                  </div>
                </div>

                <div className="flex gap-2 pt-2">
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => updateStatusMutation.mutate({ id: rec.id, status: 'implemented' })}
                    disabled={updateStatusMutation.isPending}
                    data-testid={`button-implement-${rec.id}`}
                  >
                    <CheckCircle2 className="h-3 w-3 mr-1" />
                    Mark Implemented
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => updateStatusMutation.mutate({ id: rec.id, status: 'dismissed' })}
                    disabled={updateStatusMutation.isPending}
                    data-testid={`button-dismiss-${rec.id}`}
                  >
                    <XCircle className="h-3 w-3 mr-1" />
                    Dismiss
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
