import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Area, AreaChart } from "recharts";
import { TrendingUp, Loader2, AlertTriangle, CheckCircle2, DollarSign, Cloud } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";

type CloudProvider = "all" | "aws" | "gcp" | "azure";

interface ForecastData {
  date: string;
  predictedCost: number;
  confidenceInterval: {
    lower: number;
    upper: number;
  };
}

interface ForecastResult {
  success: boolean;
  forecasts: ForecastData[];
  summary: {
    historicalAverage: number;
    forecastAverage: number;
    totalForecastedCost: number;
    changePercentage: number;
  };
  recommendations: Array<{
    type: string;
    severity: string;
    message: string;
    recommended_budget: number;
  }>;
  modelMetrics?: {
    mape: number;
    accuracy: number;
  };
  dataPoints?: number;
  error?: string;
}

export default function Forecast() {
  const { toast } = useToast();
  const [forecastDays, setForecastDays] = useState(30);
  const [selectedProvider, setSelectedProvider] = useState<CloudProvider>("all");

  // Fetch forecast mutation
  const forecastMutation = useMutation({
    mutationFn: async ({ days, provider }: { days: number; provider: CloudProvider }) => {
      return apiRequest<ForecastResult>("POST", "/api/forecast", { 
        forecastDays: days,
        provider: provider === "all" ? undefined : provider
      });
    },
    onSuccess: () => {
      toast({
        title: "Forecast generated",
        description: "Cost forecast has been successfully generated using ML algorithms",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/forecast", selectedProvider] });
    },
    onError: (error: any) => {
      toast({
        title: "Forecast failed",
        description: error.message || "Failed to generate cost forecast",
        variant: "destructive",
      });
    },
  });

  const forecastData = forecastMutation.data;

  // Prepare chart data with safety checks
  const chartData = forecastData?.success && forecastData?.forecasts?.map((f) => ({
    date: new Date(f.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    predicted: f.predictedCost,
    lower: f.confidenceInterval?.lower || 0,
    upper: f.confidenceInterval?.upper || 0,
  })) || [];

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'high':
        return 'destructive';
      case 'medium':
        return 'default';
      case 'low':
        return 'secondary';
      default:
        return 'secondary';
    }
  };

  const getSeverityIcon = (severity: string) => {
    switch (severity) {
      case 'high':
        return <AlertTriangle className="h-4 w-4" />;
      case 'low':
        return <CheckCircle2 className="h-4 w-4" />;
      default:
        return <TrendingUp className="h-4 w-4" />;
    }
  };

  const getProviderName = (provider: CloudProvider) => {
    switch (provider) {
      case "aws": return "AWS";
      case "gcp": return "GCP";
      case "azure": return "Azure";
      case "all": return "Multi-Cloud";
      default: return "Multi-Cloud";
    }
  };

  const renderForecastContent = () => (
    <>
      <div className="flex items-center justify-between mb-6">
        <div className="flex gap-3">
          <Button
            onClick={() => {
              setForecastDays(30);
              forecastMutation.mutate({ days: 30, provider: selectedProvider });
            }}
            variant={forecastDays === 30 ? "default" : "outline"}
            disabled={forecastMutation.isPending}
            data-testid="button-forecast-30"
          >
            30 Days
          </Button>
          <Button
            onClick={() => {
              setForecastDays(60);
              forecastMutation.mutate({ days: 60, provider: selectedProvider });
            }}
            variant={forecastDays === 60 ? "default" : "outline"}
            disabled={forecastMutation.isPending}
            data-testid="button-forecast-60"
          >
            60 Days
          </Button>
          <Button
            onClick={() => {
              setForecastDays(90);
              forecastMutation.mutate({ days: 90, provider: selectedProvider });
            }}
            variant={forecastDays === 90 ? "default" : "outline"}
            disabled={forecastMutation.isPending}
            data-testid="button-forecast-90"
          >
            90 Days
          </Button>
        </div>
      </div>

      {forecastMutation.isPending && (
        <Card>
          <CardContent className="flex items-center justify-center py-12">
            <div className="text-center space-y-3">
              <Loader2 className="h-8 w-8 animate-spin mx-auto text-primary" />
              <p className="text-sm text-muted-foreground">
                Generating forecast using ML algorithms...
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {forecastData && !forecastData.success && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Forecast Generation Failed</AlertTitle>
          <AlertDescription>
            {forecastData.error || 'Unable to generate forecast. Please ensure you have sufficient historical cost data.'}
          </AlertDescription>
        </Alert>
      )}

      {forecastData && forecastData.success && forecastData.summary && (
        <>
          {/* Summary Cards */}
          <div className="grid gap-4 md:grid-cols-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Historical Avg</CardTitle>
                <DollarSign className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  ${(forecastData.summary.historicalAverage || 0).toLocaleString()}
                </div>
                <p className="text-xs text-muted-foreground">
                  Past {forecastData.dataPoints || 0} days
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Forecast Avg</CardTitle>
                <TrendingUp className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  ${(forecastData.summary.forecastAverage || 0).toLocaleString()}
                </div>
                <p className="text-xs text-muted-foreground">
                  Next {forecastDays} days
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Change</CardTitle>
                <TrendingUp className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className={`text-2xl font-bold ${(forecastData.summary.changePercentage || 0) > 0 ? 'text-red-500' : 'text-green-500'}`}>
                  {(forecastData.summary.changePercentage || 0) > 0 ? '+' : ''}
                  {typeof forecastData.summary.changePercentage === 'number' ? forecastData.summary.changePercentage.toFixed(1) : '0.0'}%
                </div>
                <p className="text-xs text-muted-foreground">
                  vs historical
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Model Accuracy</CardTitle>
                <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {typeof forecastData.modelMetrics?.accuracy === 'number' ? forecastData.modelMetrics.accuracy.toFixed(1) : 'N/A'}%
                </div>
                <p className="text-xs text-muted-foreground">
                  MAPE: {typeof forecastData.modelMetrics?.mape === 'number' ? forecastData.modelMetrics.mape.toFixed(1) : 'N/A'}%
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Forecast Chart */}
          <Card>
            <CardHeader>
              <CardTitle>Cost Forecast Visualization</CardTitle>
              <CardDescription>
                Predicted costs with 95% confidence intervals using Ridge Regression
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={400}>
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id="colorPredicted" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis
                    dataKey="date"
                    className="text-xs"
                    tick={{ fill: 'hsl(var(--muted-foreground))' }}
                  />
                  <YAxis
                    className="text-xs"
                    tick={{ fill: 'hsl(var(--muted-foreground))' }}
                    tickFormatter={(value) => `$${value}`}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'hsl(var(--card))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px',
                    }}
                    formatter={(value: any) => `$${value.toFixed(2)}`}
                  />
                  <Legend />
                  <Area
                    type="monotone"
                    dataKey="upper"
                    stroke="hsl(var(--muted-foreground))"
                    fill="hsl(var(--muted))"
                    fillOpacity={0.2}
                    name="Upper Bound"
                  />
                  <Area
                    type="monotone"
                    dataKey="lower"
                    stroke="hsl(var(--muted-foreground))"
                    fill="hsl(var(--muted))"
                    fillOpacity={0.2}
                    name="Lower Bound"
                  />
                  <Line
                    type="monotone"
                    dataKey="predicted"
                    stroke="hsl(var(--primary))"
                    strokeWidth={3}
                    dot={false}
                    name="Predicted Cost"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Recommendations */}
          <Card>
            <CardHeader>
              <CardTitle>Budget Recommendations</CardTitle>
              <CardDescription>
                AI-generated recommendations based on forecast analysis
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {forecastData.recommendations.map((rec, index) => (
                <Alert key={index} variant={getSeverityColor(rec.severity) as any}>
                  <div className="flex items-start gap-3">
                    {getSeverityIcon(rec.severity)}
                    <div className="flex-1">
                      <AlertTitle className="flex items-center gap-2">
                        {rec.type.replace('_', ' ').toUpperCase()}
                        <Badge variant={getSeverityColor(rec.severity) as any}>
                          {rec.severity}
                        </Badge>
                      </AlertTitle>
                      <AlertDescription className="mt-2">
                        {rec.message}
                      </AlertDescription>
                      <div className="mt-3 text-sm font-medium">
                        Recommended Budget: ${rec.recommended_budget.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </div>
                    </div>
                  </div>
                </Alert>
              ))}
            </CardContent>
          </Card>
        </>
      )}

      {!forecastData && !forecastMutation.isPending && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <TrendingUp className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">Generate Cost Forecast</h3>
            <p className="text-sm text-muted-foreground text-center max-w-md mb-6">
              Use machine learning to predict future {getProviderName(selectedProvider)} costs based on historical patterns
            </p>
            <Button
              onClick={() => forecastMutation.mutate({ days: 30, provider: selectedProvider })}
              size="lg"
              data-testid="button-generate-forecast"
            >
              Generate 30-Day Forecast
            </Button>
          </CardContent>
        </Card>
      )}
    </>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            {getProviderName(selectedProvider)} Cost Forecasting
          </h1>
          <p className="text-muted-foreground mt-2">
            ML-powered predictions for future {getProviderName(selectedProvider)} spending
          </p>
        </div>
      </div>

      <Tabs value={selectedProvider} onValueChange={(value) => setSelectedProvider(value as CloudProvider)} className="space-y-6">
        <TabsList className="grid w-full grid-cols-4" data-testid="tabs-provider-selector">
          <TabsTrigger value="all" data-testid="tab-all" className="gap-2">
            <Cloud className="h-4 w-4" />
            All Clouds
          </TabsTrigger>
          <TabsTrigger value="aws" data-testid="tab-aws" className="gap-2">
            <Cloud className="h-4 w-4" />
            AWS
          </TabsTrigger>
          <TabsTrigger value="gcp" data-testid="tab-gcp" className="gap-2">
            <Cloud className="h-4 w-4" />
            GCP
          </TabsTrigger>
          <TabsTrigger value="azure" data-testid="tab-azure" className="gap-2">
            <Cloud className="h-4 w-4" />
            Azure
          </TabsTrigger>
        </TabsList>

        <TabsContent value="all" className="space-y-6">
          {renderForecastContent()}
        </TabsContent>

        <TabsContent value="aws" className="space-y-6">
          {renderForecastContent()}
        </TabsContent>

        <TabsContent value="gcp" className="space-y-6">
          {renderForecastContent()}
        </TabsContent>

        <TabsContent value="azure" className="space-y-6">
          {renderForecastContent()}
        </TabsContent>
      </Tabs>
    </div>
  );
}
