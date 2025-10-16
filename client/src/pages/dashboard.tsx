import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { DollarSign, TrendingUp, Server, Calendar, RefreshCw, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { queryClient } from "@/lib/queryClient";
import { CostSummaryCard } from "@/components/cost-summary-card";
import { DailyTrendChart } from "@/components/daily-trend-chart";
import { ServiceBreakdownChart } from "@/components/service-breakdown-chart";
import { SubscriptionChart } from "@/components/subscription-chart";
import { CostDistributionTable } from "@/components/cost-distribution-table";
import { InsightsPanel } from "@/components/insights-panel";
import { useToast } from "@/hooks/use-toast";
import type { ProcessedCostData, AnomalyDetectionResult } from "@shared/schema";

export default function Dashboard() {
  const [selectedService, setSelectedService] = useState("all");
  const { toast } = useToast();

  const { data: costData, isLoading: costLoading, refetch: refetchCostData } = useQuery<ProcessedCostData>({
    queryKey: ["/api/cost-data"],
  });

  const { data: anomalyData, isLoading: anomalyLoading } = useQuery<AnomalyDetectionResult>({
    queryKey: ["/api/anomalies"],
    enabled: !!costData,
  });

  const handleRefresh = async () => {
    await refetchCostData();
    queryClient.invalidateQueries({ queryKey: ["/api/anomalies"] });
  };

  const handleExport = async (exportType: string) => {
    try {
      const response = await fetch(`/api/export/${exportType}`);
      if (!response.ok) throw new Error("Export failed");
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${exportType}-${new Date().toISOString().split('T')[0]}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
      
      toast({
        title: "Export successful",
        description: `Your ${exportType.replace(/-/g, ' ')} has been downloaded.`,
      });
    } catch (error) {
      toast({
        title: "Export failed",
        description: "Failed to export data. Please try again.",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Azure Cost Dashboard</h1>
          <p className="text-muted-foreground mt-1">
            Monitor and analyze your Azure cloud spending
          </p>
        </div>
        <div className="flex gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" data-testid="button-export">
                <Download className="h-4 w-4 mr-2" />
                Export Data
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Export Options</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => handleExport('cost-history')} data-testid="export-cost-history">
                Cost History
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExport('service-breakdown')} data-testid="export-service-breakdown">
                Service Breakdown
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExport('anomalies')} data-testid="export-anomalies">
                Anomalies
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExport('forecast')} data-testid="export-forecast">
                Forecast (30 days)
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => handleExport('comprehensive-report')} data-testid="export-comprehensive">
                Comprehensive Report
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button onClick={handleRefresh} variant="outline" data-testid="button-refresh">
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh Data
          </Button>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
        <CostSummaryCard
          title="Total Cost"
          value={costData ? `$${costData.totalCost.toFixed(2)}` : "$0.00"}
          icon={DollarSign}
          loading={costLoading}
          variant="blue"
        />
        <CostSummaryCard
          title="Avg Daily Cost"
          value={costData ? `$${costData.avgDailyCost.toFixed(2)}` : "$0.00"}
          icon={TrendingUp}
          loading={costLoading}
          variant="green"
        />
        <CostSummaryCard
          title="Top Service"
          value={costData ? costData.topService.name : "N/A"}
          icon={Server}
          loading={costLoading}
          variant="purple"
        />
        <CostSummaryCard
          title="Service Count"
          value={costData ? costData.serviceCount.toString() : "0"}
          icon={Calendar}
          loading={costLoading}
          variant="orange"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <DailyTrendChart
            data={costData?.dailyTrends || []}
            services={costData?.services || []}
            selectedService={selectedService}
            onServiceChange={setSelectedService}
            loading={costLoading}
          />

          <div className="grid gap-6 md:grid-cols-2">
            <ServiceBreakdownChart
              data={costData?.serviceBreakdown || []}
              loading={costLoading}
              limit={10}
              title="Top 10 Services"
            />
            <SubscriptionChart
              data={costData?.subscriptionBreakdown || []}
              loading={costLoading}
            />
          </div>

          <CostDistributionTable
            data={costData?.serviceBreakdown || []}
            loading={costLoading}
          />
        </div>

        <div className="space-y-6">
          <InsightsPanel
            peakDay={costData?.peakDay}
            topServicePercentage={costData?.serviceBreakdown[0]?.percentage}
            serviceCount={costData?.serviceCount}
            anomalies={anomalyData?.anomalies}
            loading={costLoading || anomalyLoading}
          />
        </div>
      </div>
    </div>
  );
}
