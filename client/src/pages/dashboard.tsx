import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { DollarSign, TrendingUp, Server, Calendar, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { queryClient } from "@/lib/queryClient";
import { CostSummaryCard } from "@/components/cost-summary-card";
import { DailyTrendChart } from "@/components/daily-trend-chart";
import { ServiceBreakdownChart } from "@/components/service-breakdown-chart";
import { CostDistributionTable } from "@/components/cost-distribution-table";
import { InsightsPanel } from "@/components/insights-panel";
import type { ProcessedCostData, AnomalyDetectionResult } from "@shared/schema";

export default function Dashboard() {
  const [selectedService, setSelectedService] = useState("all");

  const { data: costData, isLoading: costLoading, refetch: refetchCostData } = useQuery<ProcessedCostData>({
    queryKey: ["/api/cost-data"],
  });

  const { data: anomalyData, isLoading: anomalyLoading } = useQuery<AnomalyDetectionResult>({
    queryKey: ["/api/anomalies"],
    enabled: !!costData,
  });

  const handleRefresh = async () => {
    await refetchCostData();
    // Also refetch anomalies after cost data is refreshed
    queryClient.invalidateQueries({ queryKey: ["/api/anomalies"] });
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
        <Button onClick={handleRefresh} variant="outline" data-testid="button-refresh">
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh Data
        </Button>
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
        <CostSummaryCard
          title="Total Cost"
          value={costData ? `$${costData.totalCost.toFixed(2)}` : "$0.00"}
          icon={DollarSign}
          loading={costLoading}
        />
        <CostSummaryCard
          title="Avg Daily Cost"
          value={costData ? `$${costData.avgDailyCost.toFixed(2)}` : "$0.00"}
          icon={TrendingUp}
          loading={costLoading}
        />
        <CostSummaryCard
          title="Top Service"
          value={costData ? costData.topService.name : "N/A"}
          icon={Server}
          loading={costLoading}
        />
        <CostSummaryCard
          title="Service Count"
          value={costData ? costData.serviceCount.toString() : "0"}
          icon={Calendar}
          loading={costLoading}
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
            <ServiceBreakdownChart
              data={costData?.serviceBreakdown || []}
              loading={costLoading}
              limit={8}
              title="Top 8 Cost Drivers"
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
