import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { DollarSign, TrendingUp, Server, Calendar, RefreshCw, Download, Cloud, Zap, Database, CloudCog, AlertTriangle } from "lucide-react";
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
import { AwsAccountsSection } from "@/components/aws-accounts-section";
import { ServiceBreakdownChart } from "@/components/service-breakdown-chart";
import { SubscriptionChart } from "@/components/subscription-chart";
import { CostDistributionTable } from "@/components/cost-distribution-table";
import { InsightsPanel } from "@/components/insights-panel";
import { QuickWinsPanel } from "@/components/quick-wins-panel";
import { ServiceAnalysisModal } from "@/components/service-analysis-modal";
import { DateRangePicker } from "@/components/date-range-picker";
import { useDateRange } from "@/contexts/date-range-context";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TagAllocationPanel } from "@/components/tag-allocation-panel";
import type { CostBasis } from "@/hooks/use-cost-store";
import { useToast } from "@/hooks/use-toast";
import type { ProcessedCostData, AnomalyDetectionResult } from "@shared/schema";

type CloudProvider = 'all' | 'aws' | 'gcp' | 'azure';

/**
 * Manual refresh cooldown.
 *
 * Refresh re-runs every query the dashboard renders from. Without a cooldown a
 * held-down button re-runs all of them on every click, and the cost query can
 * fall through to the live provider APIs — which are billed per request on AWS
 * and throttled hard on Azure. An hour is also about as often as the providers
 * publish new figures, so a shorter window would spend money to redisplay the
 * same numbers.
 */
const REFRESH_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * Persisted so the cooldown survives a page reload and applies across tabs.
 * Component state alone would reset on F5, which makes the limit trivial to
 * bypass without meaning to.
 */
const REFRESH_STAMP_KEY = 'dashboard:last-refresh-at';

function readLastRefresh(): number {
  const raw = localStorage.getItem(REFRESH_STAMP_KEY);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** "43 min" / "22 sec" — whichever unit reads naturally at that distance. */
function formatRemaining(ms: number): string {
  const mins = Math.ceil(ms / 60_000);
  return mins > 1 ? `${mins} min` : `${Math.max(1, Math.ceil(ms / 1000))} sec`;
}

/** Every query the dashboard renders data from. Refresh re-runs all of these. */
const DASHBOARD_QUERY_KEYS = [
  '/api/costs/processed',
  '/api/anomalies',
  '/api/optimization/recommendations',
  '/api/service-analysis',
] as const;

/**
 * ProcessedCostData plus provenance. `source` says where the numbers came from
 * and `costBasis` says which cost they are — showing a figure without being able
 * to answer either question is how a dashboard loses the finance team.
 */
type CostDataResponse = ProcessedCostData & {
  source: 'facts' | 'live';
  costBasis?: 'billed' | 'effective';
  coverage?: { latest: string | null; lastUpdated: string | null; rows: number };
};

export default function Dashboard() {
  const [selectedService, setSelectedService] = useState("all");
  const [selectedProvider, setSelectedProvider] = useState<CloudProvider>("all");
  const [analysisModalOpen, setAnalysisModalOpen] = useState(false);
  const [selectedServiceForAnalysis, setSelectedServiceForAnalysis] = useState<string | null>(null);
  const { toast } = useToast();

  // Read from localStorage on mount so a reload does not reset the cooldown.
  const [lastRefreshAt, setLastRefreshAt] = useState<number>(() => readLastRefresh());
  const [refreshing, setRefreshing] = useState(false);
  // Drives the countdown on the button label. Ticks only while a cooldown is
  // actually in progress, so an idle dashboard does not re-render every 30s.
  const [nowTs, setNowTs] = useState(() => Date.now());

  const cooldownRemaining = lastRefreshAt > 0
    ? Math.max(0, REFRESH_COOLDOWN_MS - (nowTs - lastRefreshAt))
    : 0;

  useEffect(() => {
    if (cooldownRemaining <= 0) return;
    const t = setInterval(() => setNowTs(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [cooldownRemaining > 0]);
  const { dateRange } = useDateRange();

  /**
   * Which cost the dashboard reports.
   *
   * effective — commitments amortized and credits applied. The right basis for
   *             optimization and showback, and the default.
   * billed    — what the invoice says. Use when reconciling with finance.
   *
   * Offering the choice, and labelling which is shown, is the difference
   * between a number someone can defend and one they merely quote.
   */
  const [costBasis, setCostBasis] = useState<CostBasis>('effective');

  // Cost data comes from the ingested fact store rather than a live provider
  // API call per page load. When the store has nothing for the selected window
  // — a new tenant, or a range predating the first ingestion — the endpoint
  // reports source:'empty' and we fall back to the live path, so the dashboard
  // is never blank in a way that reads as "you spent nothing".
  const { data: costResponse, isLoading: costLoading, refetch: refetchCostData } = useQuery<CostDataResponse>({
    queryKey: ["/api/costs/processed", selectedProvider, dateRange.startDate, dateRange.endDate, costBasis],
    queryFn: async () => {
      const params = new URLSearchParams({
        startDate: dateRange.startDate,
        endDate: dateRange.endDate,
        costBasis,
      });
      if (selectedProvider !== "all") {
        params.append('provider', selectedProvider);
      }

      const stored = await fetch(`/api/costs/processed?${params.toString()}`, { credentials: 'include' });
      if (stored.ok) {
        const payload = await stored.json();
        if (payload.source === 'facts') return payload as CostDataResponse;
      }

      const live = await fetch(`/api/cost-data?${params.toString()}`, { credentials: 'include' });
      if (!live.ok) throw new Error('Failed to fetch cost data');
      return { ...(await live.json()), source: 'live' } as CostDataResponse;
    },
  });

  const costData = costResponse as ProcessedCostData | undefined;

  const { data: anomalyData, isLoading: anomalyLoading } = useQuery<AnomalyDetectionResult>({
    queryKey: ["/api/anomalies", selectedProvider, dateRange.startDate, dateRange.endDate],
    queryFn: async () => {
      const params = new URLSearchParams({
        startDate: dateRange.startDate,
        endDate: dateRange.endDate,
      });
      
      if (selectedProvider !== "all") {
        params.append('provider', selectedProvider);
      }
      
      const url = `/api/anomalies?${params.toString()}`;
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to fetch anomalies');
      return await response.json();
    },
    enabled: !!costData,
  });

  // Service analysis query
  const { data: analysisData, isLoading: analysisLoading } = useQuery({
    queryKey: ['/api/service-analysis', selectedServiceForAnalysis, selectedProvider, dateRange.startDate, dateRange.endDate],
    queryFn: async () => {
      if (!selectedServiceForAnalysis) return null;
      
      // Determine provider - if "all" is selected, try to detect from service name
      let provider = selectedProvider;
      if (provider === 'all') {
        // Fallback detection from service name
        if (selectedServiceForAnalysis.startsWith('Amazon ') || selectedServiceForAnalysis.startsWith('AWS ')) {
          provider = 'aws';
        } else if (selectedServiceForAnalysis.startsWith('Azure ') || selectedServiceForAnalysis.startsWith('Microsoft ')) {
          provider = 'azure';
        } else if (selectedServiceForAnalysis.startsWith('Google ')) {
          provider = 'gcp';
        }
      }
      
      const response = await fetch('/api/service-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          service: selectedServiceForAnalysis,
          provider: provider,
          startDate: dateRange.startDate,
          endDate: dateRange.endDate,
        }),
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Analysis failed');
      }
      
      const result = await response.json();
      return result.data;
    },
    enabled: !!selectedServiceForAnalysis && analysisModalOpen,
  });

  // Handle service click for analysis
  const handleServiceClick = (serviceName: string) => {
    setSelectedServiceForAnalysis(serviceName);
    setAnalysisModalOpen(true);
  };

  const handleCloseAnalysisModal = () => {
    setAnalysisModalOpen(false);
    setSelectedServiceForAnalysis(null);
  };

  // Fetch optimization recommendations for savings card
  const { data: recommendationsData } = useQuery({
    queryKey: ['/api/optimization/recommendations', selectedProvider, dateRange.startDate, dateRange.endDate],
    queryFn: async () => {
      const params = new URLSearchParams({
        startDate: dateRange.startDate,
        endDate: dateRange.endDate,
      });
      
      if (selectedProvider !== "all") {
        params.append('provider', selectedProvider);
      }
      
      const url = `/api/optimization/recommendations?${params.toString()}`;
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to fetch recommendations');
      return await response.json();
    },
  });

  /**
   * Re-runs every dashboard query, at most once an hour.
   *
   * Inside the cooldown this returns without issuing a single request — the
   * point of the limit is that no API is called, not merely that the button
   * looks busy. The remaining time is reported rather than swallowed: a button
   * that silently does nothing is what made the old one untrustworthy.
   */
  const handleRefresh = async () => {
    const since = Date.now() - lastRefreshAt;

    if (lastRefreshAt > 0 && since < REFRESH_COOLDOWN_MS) {
      toast({
        title: 'Already up to date',
        description:
          `Refreshed ${formatRemaining(since)} ago. ` +
          `Next refresh available in ${formatRemaining(REFRESH_COOLDOWN_MS - since)}.`,
      });
      return;
    }

    setRefreshing(true);
    try {
      // Pull current figures from the cloud providers first. Re-running the
      // dashboard queries alone would only re-read the stored table and return
      // the same numbers, which is what made the old button look broken.
      const pull = await fetch('/api/costs/refresh', {
        method: 'POST',
        credentials: 'include',
      });
      const payload = await pull.json().catch(() => ({}));

      if (pull.status === 429) {
        // The server owns the cooldown; adopt its answer so the button agrees
        // with it even if this browser's clock or storage says otherwise.
        const readyAt = Date.now() - (REFRESH_COOLDOWN_MS - payload.retryAfterSeconds * 1000);
        localStorage.setItem(REFRESH_STAMP_KEY, String(readyAt));
        setLastRefreshAt(readyAt);
        setNowTs(Date.now());
        toast({
          title: 'Already up to date',
          description: `Next refresh available in ${formatRemaining(payload.retryAfterSeconds * 1000)}.`,
        });
        return;
      }

      if (!pull.ok) {
        throw new Error(payload.error ?? `Refresh failed (${pull.status})`);
      }

      // invalidateQueries refetches the active ones and marks the rest stale, so
      // a modal-gated query (service analysis) is not fetched while it is closed.
      await Promise.all(
        DASHBOARD_QUERY_KEYS.map((key) => queryClient.invalidateQueries({ queryKey: [key] })),
      );

      const now = Date.now();
      localStorage.setItem(REFRESH_STAMP_KEY, String(now));
      setLastRefreshAt(now);

      // Per provider, because one cloud throttling is a normal outcome and
      // should not read as a total failure.
      const failed = (payload.results ?? []).filter((r: any) => r.status !== 'success');
      toast({
        title: 'Dashboard refreshed',
        description: failed.length === 0
          ? `${payload.totalRecords ?? 0} record(s) updated from all providers.`
          : `${payload.totalRecords ?? 0} record(s) updated. Incomplete: ` +
            failed.map((r: any) => `${r.provider} (${r.status})`).join(', '),
        variant: failed.length > 0 ? 'destructive' : undefined,
      });
    } catch (err) {
      // The stamp is deliberately not written on failure, so a failed refresh
      // does not lock the button for an hour.
      toast({
        title: 'Refresh failed',
        description: (err as Error)?.message ?? 'Could not refresh dashboard data.',
        variant: 'destructive',
      });
    } finally {
      setRefreshing(false);
    }
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

  // Calculate total potential savings from recommendations
  const totalSavings = (recommendationsData as { success: boolean; recommendations: any[] })?.recommendations?.reduce(
    (sum, rec) => sum + parseFloat(rec.potentialSavings?.toString() || '0'),
    0
  ) || 0;

  // Calculate Week-over-Week trend
  const calculateWoWTrend = () => {
    if (!costData?.dailyTrends || costData.dailyTrends.length < 14) return null;
    
    const sortedDays = [...costData.dailyTrends].sort((a, b) => 
      new Date(a.date).getTime() - new Date(b.date).getTime()
    );
    
    const lastWeek = sortedDays.slice(-7);
    const previousWeek = sortedDays.slice(-14, -7);
    
    const lastWeekTotal = lastWeek.reduce((sum, day) => sum + day.cost, 0);
    const previousWeekTotal = previousWeek.reduce((sum, day) => sum + day.cost, 0);
    
    if (previousWeekTotal === 0) return null;
    
    const change = ((lastWeekTotal - previousWeekTotal) / previousWeekTotal) * 100;
    return {
      value: `${Math.abs(change).toFixed(1)}%`,
      isPositive: change < 0, // Negative change (cost reduction) is positive
    };
  };

  const wowTrend = calculateWoWTrend();

  // Extract metadata from API response to know if provider is real or sample data
  const metadata = (costData as any)?._metadata as {
    dataSource: string;
    awsConfigured: boolean;
    gcpConfigured: boolean;
    azureConfigured: boolean;
    warnings?: string[];
  } | undefined;

  const isProviderConfigured = (provider: CloudProvider) => {
    if (provider === 'aws') return metadata?.awsConfigured ?? true;
    if (provider === 'gcp') return metadata?.gcpConfigured ?? false;
    if (provider === 'azure') return metadata?.azureConfigured ?? false;
    return true; // 'all' always shows
  };

  const renderNotConfigured = (provider: string) => (
    <div className="flex flex-col items-center justify-center py-24 gap-4 rounded-lg border border-yellow-300 bg-yellow-50 dark:bg-yellow-950/20 dark:border-yellow-700">
      <AlertTriangle className="h-10 w-10 text-yellow-500" />
      <div className="text-center">
        <p className="text-lg font-semibold text-yellow-800 dark:text-yellow-300">{provider} Not Configured</p>
        <p className="text-sm text-yellow-700 dark:text-yellow-400 mt-1">
          Add your {provider} credentials in the Configuration page to see real cost data.
        </p>
      </div>
    </div>
  );

  const renderDashboardContent = () => (
    <>
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
        <CostSummaryCard
          title="Total Cost"
          value={costData ? `$${costData.totalCost.toFixed(2)}` : "$0.00"}
          icon={DollarSign}
          loading={costLoading}
          variant="blue"
          trend={wowTrend || undefined}
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
        {/* <CostSummaryCard
          title="Potential Savings"
          value={`$${totalSavings.toFixed(2)}`}
          icon={Zap}
          loading={costLoading}
          variant="purple"
          data-testid={`card-potential-savings-${selectedProvider}`}
        /> */}
        <CostSummaryCard
          title="Top Service"
          value={costData ? costData.topService.name : "N/A"}
          icon={Server}
          loading={costLoading}
          variant="orange"
          data-testid={`card-top-service-${selectedProvider}`}
        />
        <CostSummaryCard
          title="Service Count"
          value={costData ? costData.serviceCount.toString() : "0"}
          icon={Calendar}
          loading={costLoading}
          variant="blue"
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
              onServiceClick={handleServiceClick}
            />
            <SubscriptionChart
              data={costData?.subscriptionBreakdown || []}
              loading={costLoading}
            />
          </div>

          <CostDistributionTable
            data={costData?.serviceBreakdown || []}
            loading={costLoading}
            onServiceClick={handleServiceClick}
          />
        </div>

        <div className="space-y-6">
          <InsightsPanel
            peakDay={costData?.peakDay}
            topServicePercentage={costData?.serviceBreakdown[0]?.percentage}
            serviceCount={costData?.serviceCount}
            anomalies={anomalyData?.anomalies as any}
            loading={costLoading || anomalyLoading}
          />
          
          <QuickWinsPanel
            recommendations={(recommendationsData as { success: boolean; recommendations: any[] })?.recommendations}
            loading={costLoading}
          />

          {/* Allocation only means anything against ingested data — the live
              path carries no tags. */}
          {costResponse?.source === 'facts' && (
            <TagAllocationPanel
              start={dateRange.startDate}
              end={dateRange.endDate}
              costBasis={costBasis}
              provider={selectedProvider}
            />
          )}
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
          {/* Where these numbers came from and which cost they are. Both matter
              when someone asks why the dashboard disagrees with the invoice. */}
          {costResponse && (
            <p className="text-xs text-muted-foreground mt-1.5" data-testid="text-data-provenance">
              {costResponse.source === 'facts' ? (
                <>
                  {costResponse.costBasis === 'billed' ? 'Billed cost' : 'Effective cost'}
                  {' · ingested data'}
                  {costResponse.coverage?.lastUpdated &&
                    ` · updated ${new Date(costResponse.coverage.lastUpdated).toLocaleString()}`}
                </>
              ) : (
                <>Live provider data · not yet ingested</>
              )}
            </p>
          )}
        </div>
        <div className="flex gap-2 flex-wrap">
          {/* Only meaningful against the fact store — the live path returns one
              unlabelled number, so the choice is hidden rather than shown as a
              control that silently does nothing. */}
          {costResponse?.source === 'facts' && (
            <Select value={costBasis} onValueChange={v => setCostBasis(v as CostBasis)}>
              <SelectTrigger className="w-44" data-testid="select-cost-basis">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="effective">Effective cost</SelectItem>
                <SelectItem value="billed">Billed cost</SelectItem>
              </SelectContent>
            </Select>
          )}
          <DateRangePicker />
          <DropdownMenu>
            {/* <DropdownMenuTrigger asChild>
              <Button variant="outline" data-testid="button-export">
                <Download className="h-4 w-4 mr-2" />
                Export Data
              </Button>
            </DropdownMenuTrigger> */}
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
          {/*
            Disabled during the cooldown rather than clickable-but-inert, and the
            title says why. The countdown is on the label so the limit is visible
            before the click, not explained after it.
          */}
          <Button
            onClick={handleRefresh}
            variant="outline"
            data-testid="button-refresh"
            disabled={refreshing || cooldownRemaining > 0}
            title={
              cooldownRemaining > 0
                ? `Refreshed recently. Next refresh available in ${formatRemaining(cooldownRemaining)}.`
                : 'Re-fetch cost, anomaly and recommendation data'
            }
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing
              ? 'Refreshing…'
              : cooldownRemaining > 0
                ? `Refresh in ${formatRemaining(cooldownRemaining)}`
                : 'Refresh Data'}
          </Button>
        </div>
      </div>

      <Tabs value={selectedProvider} onValueChange={(value) => setSelectedProvider(value as CloudProvider)} className="space-y-6">
        <TabsList className="grid w-full grid-cols-4" data-testid="tabs-provider-selector">
          <TabsTrigger value="all" data-testid="tab-all" className="gap-2">
            <CloudCog className="h-4 w-4 text-purple-600 dark:text-purple-400" />
            All Clouds
          </TabsTrigger>
          <TabsTrigger value="aws" data-testid="tab-aws" className="gap-2">
            <Database className="h-4 w-4 text-orange-600 dark:text-orange-400" />
            AWS
          </TabsTrigger>
          <TabsTrigger value="gcp" data-testid="tab-gcp" className="gap-2">
            <CloudCog className="h-4 w-4 text-green-600 dark:text-green-400" />
            GCP
            {metadata && !metadata.gcpConfigured && (
              <span className="text-[10px] font-medium bg-yellow-100 dark:bg-yellow-900 text-yellow-700 dark:text-yellow-300 rounded px-1 py-0.5 leading-none">Not Configured</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="azure" data-testid="tab-azure" className="gap-2">
            <Cloud className="h-4 w-4 text-primary" />
            Azure
            {metadata && !metadata.azureConfigured && (
              <span className="text-[10px] font-medium bg-yellow-100 dark:bg-yellow-900 text-yellow-700 dark:text-yellow-300 rounded px-1 py-0.5 leading-none">Not Configured</span>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="all" className="space-y-6">
          {renderDashboardContent()}
        </TabsContent>

        <TabsContent value="aws" className="space-y-6">
          <AwsAccountsSection startDate={dateRange.startDate} endDate={dateRange.endDate} />
          {renderDashboardContent()}
        </TabsContent>

        <TabsContent value="gcp" className="space-y-6">
          {(costLoading || !metadata || isProviderConfigured('gcp')) ? renderDashboardContent() : renderNotConfigured('GCP')}
        </TabsContent>

        <TabsContent value="azure" className="space-y-6">
          {(costLoading || !metadata || isProviderConfigured('azure')) ? renderDashboardContent() : renderNotConfigured('Azure')}
        </TabsContent>
      </Tabs>

      {/* Service Analysis Modal */}
      <ServiceAnalysisModal
        open={analysisModalOpen}
        onClose={handleCloseAnalysisModal}
        serviceName={selectedServiceForAnalysis || ''}
        analysisData={analysisData}
        isLoading={analysisLoading}
      />
    </div>
  );
}
