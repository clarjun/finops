import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { DollarSign, TrendingUp, Server, Calendar, RefreshCw, Download, Cloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

type CloudProvider = 'all' | 'aws' | 'gcp' | 'azure';

export default function Dashboard() {
  const [selectedService, setSelectedService] = useState("all");
  const [selectedProvider, setSelectedProvider] = useState<CloudProvider>("all");
  const { toast } = useToast();

  const { data: costData, isLoading: costLoading, refetch: refetchCostData } = useQuery<ProcessedCostData>({
    queryKey: ["/api/cost-data", selectedProvider],
    queryFn: async () => {
      const url = selectedProvider === "all" 
        ? '/api/cost-data'
        : `/api/cost-data?provider=${selectedProvider}`;
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to fetch cost data');
      return await response.json();
    },
  });

  const { data: anomalyData, isLoading: anomalyLoading } = useQuery<AnomalyDetectionResult>({
    queryKey: ["/api/anomalies", selectedProvider],
    queryFn: async () => {
      const url = selectedProvider === "all" 
        ? '/api/anomalies'
        : `/api/anomalies?provider=${selectedProvider}`;
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to fetch anomalies');
      return await response.json();
    },
    enabled: !!costData,
  });

  const handleRefresh = async () => {
    await refetchCostData();
    queryClient.invalidateQueries({ queryKey: ["/api/anomalies"] });
  };

  const handleExport = async (exportType: string) => {
    try {
      const providerParam = selectedProvider === "all" ? "" : `?provider=${selectedProvider}`;
      const response = await fetch(`/api/export/${exportType}${providerParam}`);
      if (!response.ok) throw new Error("Export failed");
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${exportType}-${selectedProvider}-${new Date().toISOString().split('T')[0]}.csv`;
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

  const getProviderTitle = () => {
    switch (selectedProvider) {
      case 'aws':
        return 'AWS Cost Dashboard';
      case 'gcp':
        return 'GCP Cost Dashboard';
      case 'azure':
        return 'Azure Cost Dashboard';
      default:
        return 'Multi-Cloud Cost Dashboard';
    }
  };

  const getProviderDescription = () => {
    switch (selectedProvider) {
      case 'aws':
        return 'Monitor and analyze your Amazon Web Services spending';
      case 'gcp':
        return 'Monitor and analyze your Google Cloud Platform spending';
      case 'azure':
        return 'Monitor and analyze your Microsoft Azure spending';
      default:
        return 'Monitor and analyze your multi-cloud spending across AWS, GCP, and Azure';
    }
  };

  const renderDashboardContent = () => (
    <>
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
        <CostSummaryCard
          title="Total Cost"
          value={costData ? `$${costData.totalCost.toFixed(2)}` : "$0.00"}
          icon={DollarSign}
          loading={costLoading}
          variant="blue"
          data-testid={`card-total-cost-${selectedProvider}`}
        />
        <CostSummaryCard
          title="Avg Daily Cost"
          value={costData ? `$${costData.avgDailyCost.toFixed(2)}` : "$0.00"}
          icon={TrendingUp}
          loading={costLoading}
          variant="green"
          data-testid={`card-avg-daily-${selectedProvider}`}
        />
        <CostSummaryCard
          title="Top Service"
          value={costData ? costData.topService.name : "N/A"}
          icon={Server}
          loading={costLoading}
          variant="purple"
          data-testid={`card-top-service-${selectedProvider}`}
        />
        <CostSummaryCard
          title="Service Count"
          value={costData ? costData.serviceCount.toString() : "0"}
          icon={Calendar}
          loading={costLoading}
          variant="orange"
          data-testid={`card-service-count-${selectedProvider}`}
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
    </>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight" data-testid="text-dashboard-title">{getProviderTitle()}</h1>
          <p className="text-muted-foreground mt-1">
            {getProviderDescription()}
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
          {renderDashboardContent()}
        </TabsContent>

        <TabsContent value="aws" className="space-y-6">
          {renderDashboardContent()}
        </TabsContent>

        <TabsContent value="gcp" className="space-y-6">
          {renderDashboardContent()}
        </TabsContent>

        <TabsContent value="azure" className="space-y-6">
          {renderDashboardContent()}
        </TabsContent>
      </Tabs>
    </div>
  );
}
