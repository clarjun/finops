import { useState, useRef, useEffect, useCallback } from "react";
import { 
  TrendingUp, 
  TrendingDown, 
  DollarSign, 
  Target, 
  Zap, 
  AlertTriangle,
  AlertCircle,
  Server,
  HardDrive,
  Cpu,
  Package,
  Users,
  Calendar,
  RefreshCw,
  Download,
  Brain,
  Maximize2,
  Loader2
} from "lucide-react";
import jsPDF from "jspdf";
import html2canvas from "html2canvas";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DateRangePicker } from "@/components/date-range-picker";
import { useDateRange } from "@/contexts/date-range-context";
import "@/styles/pdf-export.css";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ScatterChart,
  Scatter,
  ZAxis
} from "recharts";

type CloudProvider = 'aws' | 'azure' | 'gcp';

interface ReportSections {
  spendOverview?: any;
  topCostDrivers?: any;
  expensiveResources?: any;
  costTrend?: any;
  anomalies?: any;
  wasteDetection?: any;
  utilizationData?: any;
  optimizationOpportunities?: any;
  departmentAllocation?: any;
  heatmapData?: any;
  aiSpendAnalysis?: any;
}

export default function Reports() {
  const [selectedProvider, setSelectedProvider] = useState<CloudProvider>('aws');
  const [isExporting, setIsExporting] = useState(false);
  const { dateRange } = useDateRange();
  const reportRef = useRef<HTMLDivElement>(null);

  // Streaming state
  const [sections, setSections] = useState<ReportSections>({});
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const esRef = useRef<EventSource | null>(null);

  const loadReport = useCallback(async () => {
    if (esRef.current) { esRef.current.close(); }
    setSections({});
    setIsLoading(true);
    setStatusMessage('');
    setProgress(0);

    const params = new URLSearchParams({
      provider: selectedProvider,
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
    });

    // ── Path 1 & 2: Check memory cache / DB cache — instant ──────────────
    try {
      const res = await fetch(`/api/reports/finops?${params.toString()}`);
      if (res.ok) {
        const result = await res.json();
        if (result.success && result.report && result.cached) {
          const r = result.report;
          setSections({
            spendOverview: r.spendOverview,
            topCostDrivers: r.topCostDrivers,
            expensiveResources: r.expensiveResources,
            costTrend: r.costTrend,
            anomalies: r.anomalies,
            wasteDetection: r.wasteDetection,
            utilizationData: r.utilizationData,
            optimizationOpportunities: r.optimizationOpportunities,
            departmentAllocation: r.departmentAllocation,
            heatmapData: r.heatmapData,
            aiSpendAnalysis: r.aiSpendAnalysis,
          });
          setIsLoading(false);
          setProgress(100);
          return; // served from cache — done
        }
        // result.source === 'none' means no cache — fall through to stream
      }
    } catch {
      // network error on cache check — fall through to stream
    }

    // ── Path 3: No cache — stream sections progressively ─────────────────
    setStatusMessage('Fetching data from cloud APIs...');
    const es = new EventSource(`/api/reports/finops/stream?${params.toString()}`);
    esRef.current = es;

    es.onmessage = (event) => {
      const { section, data, error } = JSON.parse(event.data);
      if (section === 'status') {
        setStatusMessage(data.message);
        setProgress(Math.round((data.step / data.total) * 100));
      } else if (section === 'done') {
        setIsLoading(false);
        setStatusMessage('');
        setProgress(100);
        es.close();
      } else if (section === 'error') {
        setIsLoading(false);
        setStatusMessage(`Error: ${data.message}`);
        es.close();
      } else {
        setSections(prev => ({ ...prev, [section]: error ? null : data }));
      }
    };

    es.onerror = () => {
      setIsLoading(false);
      setStatusMessage('Connection error. Please refresh.');
      es.close();
    };
  }, [selectedProvider, dateRange.startDate, dateRange.endDate]);

  // Load on mount and when provider/dates change
  useEffect(() => {
    loadReport();
    return () => { esRef.current?.close(); };
  }, [loadReport]);

  const handleRefresh = () => { loadReport(); };

  const handleExport = async () => {
    if (!reportRef.current || !sections.spendOverview) return;
    
    setIsExporting(true);
    try {
      const element = reportRef.current;
      
      // Add PDF export class to expand scrollable content
      element.classList.add('pdf-export-mode');
      
      // Remove scroll restrictions for PDF export
      const scrollableElements = element.querySelectorAll('[class*="max-h-"], [class*="overflow-"]');
      const originalStyles: { element: Element; maxHeight: string; overflow: string }[] = [];
      
      scrollableElements.forEach((el) => {
        const htmlEl = el as HTMLElement;
        originalStyles.push({
          element: el,
          maxHeight: htmlEl.style.maxHeight,
          overflow: htmlEl.style.overflow,
        });
        htmlEl.style.maxHeight = 'none';
        htmlEl.style.overflow = 'visible';
      });

      // Wait for layout to settle
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Capture the element as canvas
      const canvas = await html2canvas(element, {
        scale: 2,
        useCORS: true,
        logging: false,
        backgroundColor: '#ffffff',
        windowWidth: element.scrollWidth,
        windowHeight: element.scrollHeight,
      });

      // Restore original styles
      originalStyles.forEach(({ element, maxHeight, overflow }) => {
        const htmlEl = element as HTMLElement;
        htmlEl.style.maxHeight = maxHeight;
        htmlEl.style.overflow = overflow;
      });
      element.classList.remove('pdf-export-mode');

      const imgData = canvas.toDataURL('image/png');
      const pdf = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: 'a4',
      });

      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = pdf.internal.pageSize.getHeight();
      const imgWidth = canvas.width;
      const imgHeight = canvas.height;
      const ratio = Math.min(pdfWidth / imgWidth, pdfHeight / imgHeight);
      const imgX = (pdfWidth - imgWidth * ratio) / 2;

      // Add title page
      pdf.setFontSize(20);
      pdf.text('FinOps Report', pdfWidth / 2, 20, { align: 'center' });
      pdf.setFontSize(12);
      pdf.text(`Provider: ${selectedProvider.toUpperCase()}`, pdfWidth / 2, 30, { align: 'center' });
      pdf.text(`Period: ${dateRange.startDate} to ${dateRange.endDate}`, pdfWidth / 2, 37, { align: 'center' });
      pdf.text(`Generated: ${new Date().toLocaleString()}`, pdfWidth / 2, 44, { align: 'center' });

      // Calculate how many pages we need
      const pageHeight = pdfHeight - 60; // Leave space for header
      const totalPages = Math.ceil((imgHeight * ratio) / pageHeight);

      for (let i = 0; i < totalPages; i++) {
        if (i > 0) {
          pdf.addPage();
        }

        const yOffset = i * pageHeight;
        const sourceY = yOffset / ratio;
        const sourceHeight = Math.min(pageHeight / ratio, imgHeight - sourceY);

        // Create a temporary canvas for this page
        const pageCanvas = document.createElement('canvas');
        pageCanvas.width = imgWidth;
        pageCanvas.height = sourceHeight;
        const pageCtx = pageCanvas.getContext('2d');
        
        if (pageCtx) {
          pageCtx.drawImage(
            canvas,
            0, sourceY, imgWidth, sourceHeight,
            0, 0, imgWidth, sourceHeight
          );

          const pageImgData = pageCanvas.toDataURL('image/png');
          pdf.addImage(
            pageImgData,
            'PNG',
            imgX,
            i === 0 ? 55 : 10,
            imgWidth * ratio,
            sourceHeight * ratio
          );
        }
      }

      // Save the PDF
      const filename = `finops-report-${selectedProvider}-${dateRange.startDate}-${dateRange.endDate}.pdf`;
      pdf.save(filename);
    } catch (error) {
      console.error('Error generating PDF:', error);
      alert('Failed to generate PDF. Please try again.');
    } finally {
      setIsExporting(false);
    }
  };

  const report = sections;

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-4xl font-bold tracking-tight bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
            FinOps Report Dashboard
          </h1>
          <p className="text-muted-foreground mt-1">
            Comprehensive cloud cost analysis and optimization insights
          </p>
        </div>
        <div className="flex gap-3 flex-wrap">
          <DateRangePicker />
          <Button variant="outline" onClick={handleRefresh} className="gap-2" disabled={isLoading}>
            <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button
            onClick={handleExport}
            className="gap-2"
            disabled={isLoading || isExporting || !report.spendOverview}
          >
            <Download className="h-4 w-4" />
            {isExporting ? 'Exporting...' : 'Export PDF'}
          </Button>
        </div>
      </div>

      {/* Provider Tabs */}
      <Tabs value={selectedProvider} onValueChange={(v) => { setSelectedProvider(v as CloudProvider); }}>
        <TabsList className="grid w-full max-w-md grid-cols-3">
          <TabsTrigger value="aws">AWS</TabsTrigger>
          <TabsTrigger value="azure">Azure</TabsTrigger>
          <TabsTrigger value="gcp">GCP</TabsTrigger>
        </TabsList>

        <TabsContent value={selectedProvider} className="space-y-6 mt-6">
          {/* Progress bar + status while streaming */}
          {isLoading && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>{statusMessage}</span>
                <span className="ml-auto">{progress}%</span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full bg-blue-500 rounded-full transition-all duration-500"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          )}

          <div ref={reportRef} className="space-y-6">
            {/* Spend Overview — shows as soon as spendOverview arrives */}
            {report.spendOverview
              ? <SpendOverviewSection overview={report.spendOverview} />
              : <Skeleton className="h-40 w-full" />
            }

            {/* Top Cost Drivers & Expensive Resources */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {report.topCostDrivers
                ? <TopCostDriversCard drivers={report.topCostDrivers} />
                : <Skeleton className="h-64" />
              }
              {report.expensiveResources && report.expensiveResources.length > 0
                ? <ExpensiveResourcesCard resources={report.expensiveResources} />
                : report.expensiveResources !== undefined
                  ? <Card className="hover:shadow-lg transition-shadow"><CardContent className="flex items-center justify-center h-32 text-muted-foreground text-sm">No resource-level data available</CardContent></Card>
                  : <Skeleton className="h-64" />
              }
            </div>

            {/* Cost Trend */}
            {report.costTrend
              ? <CostTrendCard trend={report.costTrend} />
              : <Skeleton className="h-80 w-full" />
            }

            {/* Anomalies & Waste Detection */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {report.anomalies
                ? <AnomaliesCard anomalies={report.anomalies} />
                : <Skeleton className="h-64" />
              }
              {report.wasteDetection
                ? <WasteDetectionCard waste={report.wasteDetection} />
                : <Skeleton className="h-64" />
              }
            </div>

            {/* Optimization Opportunities */}
            {report.optimizationOpportunities
              ? <OptimizationCard opportunities={report.optimizationOpportunities} />
              : <Skeleton className="h-64 w-full" />
            }

            {/* AI Spend Analysis */}
            {report.aiSpendAnalysis
              ? <AISpendCard aiSpend={report.aiSpendAnalysis} />
              : <Skeleton className="h-48 w-full" />
            }

            {/* Department Allocation & Heatmap */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 pdf-layout-section">
              {report.departmentAllocation
                ? <DepartmentAllocationCard allocation={report.departmentAllocation} />
                : <Skeleton className="h-64" />
              }
              {report.heatmapData
                ? <HeatmapCard heatmap={report.heatmapData} />
                : <Skeleton className="h-64" />
              }
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

// Spend Overview Section
function SpendOverviewSection({ overview }: { overview: any }) {
  const hasBudget = overview.budget !== undefined && overview.budget !== null;
  const budgetStatus = hasBudget && overview.budgetUtilization > 90 ? 'critical' : 
                       hasBudget && overview.budgetUtilization > 75 ? 'warning' : 'good';
  
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
      <Card className="border-l-4 border-l-blue-500 hover:shadow-lg transition-shadow">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <DollarSign className="h-4 w-4" />
            Total Spend (MTD)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold">${overview.totalSpendMTD.toLocaleString()}</div>
          <p className="text-xs text-muted-foreground mt-1">
            Day {overview.daysIntoMonth} of {overview.daysInMonth}
          </p>
        </CardContent>
      </Card>

      <Card className="border-l-4 border-l-purple-500 hover:shadow-lg transition-shadow">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <TrendingUp className="h-4 w-4" />
            Forecast Month End
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold">${overview.forecastMonthEnd.toLocaleString()}</div>
          <p className="text-xs text-muted-foreground mt-1">
            Projected based on current trend
          </p>
        </CardContent>
      </Card>

      {hasBudget ? (
        <>
          <Card className={`border-l-4 hover:shadow-lg transition-shadow ${
            budgetStatus === 'critical' ? 'border-l-red-500' :
            budgetStatus === 'warning' ? 'border-l-yellow-500' : 'border-l-green-500'
          }`}>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <Target className="h-4 w-4" />
                Budget
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">${overview.budget.toLocaleString()}</div>
              <div className="flex items-center gap-2 mt-2">
                <div className="flex-1 bg-muted rounded-full h-2 overflow-hidden">
                  <div 
                    className={`h-full transition-all ${
                      budgetStatus === 'critical' ? 'bg-red-500' :
                      budgetStatus === 'warning' ? 'bg-yellow-500' : 'bg-green-500'
                    }`}
                    style={{ width: `${Math.min(overview.budgetUtilization, 100)}%` }}
                  />
                </div>
                <span className="text-xs font-medium">{overview.budgetUtilization.toFixed(0)}%</span>
              </div>
            </CardContent>
          </Card>

          <Card className="border-l-4 border-l-green-500 hover:shadow-lg transition-shadow bg-gradient-to-br from-green-50 to-emerald-50 dark:from-green-950 dark:to-emerald-950">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <Zap className="h-4 w-4" />
                Potential Savings
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-green-600 dark:text-green-400">
                ${overview.potentialSavings?.toLocaleString() || '0'}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Monthly optimization opportunity
              </p>
            </CardContent>
          </Card>
        </>
      ) : (
        <Card className="col-span-2 border-l-4 border-l-amber-500 hover:shadow-lg transition-shadow bg-gradient-to-br from-amber-50 to-yellow-50 dark:from-amber-950 dark:to-yellow-950">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Target className="h-4 w-4" />
              Budget & Savings
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
              <AlertCircle className="h-5 w-5" />
              <p className="text-sm font-medium">
                {overview.budgetUnavailableReason || 'Budget comparison available only for single-month range'}
              </p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// Top Cost Drivers Card
function TopCostDriversCard({ drivers }: { drivers: any[] }) {
  return (
    <Card className="hover:shadow-lg transition-shadow">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Server className="h-5 w-5" />
          Top Cost Drivers
        </CardTitle>
        <CardDescription>Top 5 services by cost</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {drivers.map((driver, idx) => (
            <div key={idx} className="flex items-center justify-between p-3 rounded-lg bg-muted/50 hover:bg-muted transition-colors">
              <div className="flex-1">
                <div className="font-medium">{driver.service}</div>
                <div className="text-xs text-muted-foreground mt-1">
                  {driver.percentage.toFixed(1)}% of total
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="text-right">
                  <div className="font-bold text-lg">${driver.cost.toLocaleString()}</div>
                  {driver.trend !== 'stable' && (
                    <div className={`text-xs flex items-center gap-1 ${
                      driver.trend === 'up' ? 'text-red-500' : 'text-green-500'
                    }`}>
                      {driver.trend === 'up' ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                      {Math.abs(driver.changePercent).toFixed(0)}%
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// Continue in next part...

// Expensive Resources Card
function ExpensiveResourcesCard({ resources }: { resources: any[] }) {
  return (
    <Card className="hover:shadow-lg transition-shadow">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Package className="h-5 w-5" />
          Top 10 Expensive Resources
        </CardTitle>
        <CardDescription>Highest cost resources</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {resources.slice(0, 10).map((resource, idx) => (
            <div key={idx} className="flex items-center justify-between p-2 rounded hover:bg-muted/50 transition-colors">
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate text-sm">{resource.resourceName}</div>
                <div className="text-xs text-muted-foreground">{resource.service} • {resource.region}</div>
              </div>
              <div className="text-right ml-4">
                <div className="font-bold">${resource.cost.toLocaleString()}</div>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// Cost Trend Card
function CostTrendCard({ trend }: { trend: any[] }) {
  return (
    <Card className="hover:shadow-lg transition-shadow">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TrendingUp className="h-5 w-5" />
          Cost Trend (Last 6 Months)
        </CardTitle>
        <CardDescription>Monthly spend with forecast</CardDescription>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={trend}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
            <XAxis dataKey="month" className="text-xs" />
            <YAxis className="text-xs" />
            <Tooltip 
              contentStyle={{ 
                backgroundColor: 'hsl(var(--background))', 
                border: '1px solid hsl(var(--border))',
                borderRadius: '8px'
              }}
              formatter={(value: any) => `$${value.toLocaleString()}`}
            />
            <Legend />
            <Line 
              type="monotone" 
              dataKey="cost" 
              stroke="hsl(var(--primary))" 
              strokeWidth={2}
              dot={{ fill: 'hsl(var(--primary))', r: 4 }}
              name="Actual Cost"
            />
            <Line 
              type="monotone" 
              dataKey="forecast" 
              stroke="hsl(var(--muted-foreground))" 
              strokeWidth={2}
              strokeDasharray="5 5"
              dot={{ fill: 'hsl(var(--muted-foreground))', r: 4 }}
              name="Forecast"
            />
          </LineChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

// Anomalies Card
function AnomaliesCard({ anomalies }: { anomalies: any[] }) {
  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'critical': return 'destructive';
      case 'high': return 'destructive';
      case 'medium': return 'secondary';
      default: return 'outline';
    }
  };

  return (
    <Card className="hover:shadow-lg transition-shadow">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-orange-500" />
          Anomaly Detection
        </CardTitle>
        <CardDescription>Cost spikes and unusual patterns</CardDescription>
      </CardHeader>
      <CardContent>
        {anomalies.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            No anomalies detected
          </div>
        ) : (
          <div className={`space-y-3 ${anomalies.length > 4 ? 'max-h-[400px] overflow-y-auto pr-2 scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-gray-700 scrollbar-track-transparent hover:scrollbar-thumb-gray-400 dark:hover:scrollbar-thumb-gray-600' : ''}`}>
            {anomalies.map((anomaly, idx) => (
              <div key={idx} className="p-3 rounded-lg border bg-card hover:bg-muted/50 transition-colors">
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <div className="font-medium">{anomaly.service}</div>
                    <div className="text-xs text-muted-foreground">{anomaly.date}</div>
                  </div>
                  <Badge variant={getSeverityColor(anomaly.severity)}>
                    {anomaly.severity}
                  </Badge>
                </div>
                <div className="text-sm">
                  <span className="capitalize">{anomaly.type}</span> of{' '}
                  <span className="font-bold text-red-500">{anomaly.changePercent.toFixed(0)}%</span>
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  ${anomaly.previousCost.toFixed(2)} → ${anomaly.currentCost.toFixed(2)}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Waste Detection Card
function WasteDetectionCard({ waste }: { waste: any }) {
  return (
    <Card className="hover:shadow-lg transition-shadow border-orange-200 dark:border-orange-900">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HardDrive className="h-5 w-5 text-orange-500" />
          Waste Detection
        </CardTitle>
        <CardDescription>Idle and underutilized resources</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-4">
            <div className="text-center p-3 rounded-lg bg-orange-50 dark:bg-orange-950">
              <div className="text-2xl font-bold text-orange-600">{waste.idleInstances}</div>
              <div className="text-xs text-muted-foreground mt-1">Idle Instances</div>
            </div>
            <div className="text-center p-3 rounded-lg bg-orange-50 dark:bg-orange-950">
              <div className="text-2xl font-bold text-orange-600">{waste.unattachedDisks}</div>
              <div className="text-xs text-muted-foreground mt-1">Unattached Disks</div>
            </div>
            <div className="text-center p-3 rounded-lg bg-orange-50 dark:bg-orange-950">
              <div className="text-2xl font-bold text-orange-600">{waste.lowCpuVMs}</div>
              <div className="text-xs text-muted-foreground mt-1">Low CPU VMs</div>
            </div>
          </div>
          
          <div className="p-4 rounded-lg bg-gradient-to-r from-orange-50 to-red-50 dark:from-orange-950 dark:to-red-950 border border-orange-200 dark:border-orange-800">
            <div className="text-sm text-muted-foreground mb-1">Potential Monthly Savings</div>
            <div className="text-3xl font-bold text-orange-600 dark:text-orange-400">
              ${waste.potentialSaving.toLocaleString()}
            </div>
          </div>

          {waste.details.idleResources.length > 0 && (
            <div className="space-y-2">
              <div className="text-sm font-medium">Idle Resources</div>
              <div className={`space-y-2 ${waste.details.idleResources.length > 5 ? 'max-h-[200px] overflow-y-auto pr-2 scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-gray-700 scrollbar-track-transparent hover:scrollbar-thumb-gray-400 dark:hover:scrollbar-thumb-gray-600' : ''}`}>
                {waste.details.idleResources.map((resource: any, idx: number) => (
                  <div key={idx} className="text-xs p-2 rounded bg-muted/50">
                    <div className="font-medium">{resource.resourceId}</div>
                    <div className="text-muted-foreground">{resource.reason} • ${resource.cost.toFixed(2)}/mo</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// Utilization Bubble Chart Card
function UtilizationBubbleCard({ utilization }: { utilization: any[] }) {
  // Transform data for bubble chart
  const bubbleData = utilization.map(u => ({
    x: u.utilization,
    y: u.cost,
    z: u.cost / 10, // Bubble size
    name: u.resourceName,
    service: u.service,
  }));

  return (
    <Card className="hover:shadow-lg transition-shadow">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Cpu className="h-5 w-5" />
          Cost vs Utilization
        </CardTitle>
        <CardDescription>Identify waste and optimization opportunities</CardDescription>
      </CardHeader>
      <CardContent>
        {utilization.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            No utilization data available
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={400}>
            <ScatterChart>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis 
                type="number" 
                dataKey="x" 
                name="Utilization" 
                unit="%" 
                domain={[0, 100]}
                label={{ value: 'CPU Utilization (%)', position: 'insideBottom', offset: -5 }}
              />
              <YAxis 
                type="number" 
                dataKey="y" 
                name="Cost" 
                unit="$"
                label={{ value: 'Monthly Cost ($)', angle: -90, position: 'insideLeft' }}
              />
              <ZAxis type="number" dataKey="z" range={[50, 400]} />
              <Tooltip 
                cursor={{ strokeDasharray: '3 3' }}
                contentStyle={{ 
                  backgroundColor: 'hsl(var(--background))', 
                  border: '1px solid hsl(var(--border))',
                  borderRadius: '8px'
                }}
                formatter={(value: any, name: string) => {
                  if (name === 'x') return [`${value.toFixed(1)}%`, 'Utilization'];
                  if (name === 'y') return [`$${value.toFixed(2)}`, 'Cost'];
                  return value;
                }}
              />
              <Scatter 
                name="Resources" 
                data={bubbleData} 
                fill="hsl(var(--primary))"
                fillOpacity={0.6}
              />
            </ScatterChart>
          </ResponsiveContainer>
        )}
        <div className="mt-4 p-3 rounded-lg bg-muted/50 text-sm">
          <div className="font-medium mb-2">Interpretation:</div>
          <ul className="space-y-1 text-xs text-muted-foreground">
            <li>• <span className="text-red-500 font-medium">High cost + Low utilization</span> = Waste (consider downsizing)</li>
            <li>• <span className="text-green-500 font-medium">High cost + High utilization</span> = Normal (well-utilized)</li>
            <li>• <span className="text-blue-500 font-medium">Low cost + Low utilization</span> = Acceptable</li>
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

// Optimization Opportunities Card
function OptimizationCard({ opportunities }: { opportunities: any[] }) {
  const totalSavings = opportunities.reduce((sum, opp) => sum + opp.monthlySavings, 0);

  const getEffortColor = (effort: string) => {
    switch (effort) {
      case 'low': return 'text-green-500';
      case 'medium': return 'text-yellow-500';
      case 'high': return 'text-red-500';
      default: return 'text-muted-foreground';
    }
  };

  return (
    <Card className="hover:shadow-lg transition-shadow bg-gradient-to-br from-blue-50 to-purple-50 dark:from-blue-950 dark:to-purple-950">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Zap className="h-5 w-5 text-yellow-500" />
          Optimization Opportunities
        </CardTitle>
        <CardDescription>Total possible savings: ${totalSavings.toLocaleString()}/month</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {opportunities.map((opp, idx) => (
            <div key={idx} className="p-4 rounded-lg bg-card border hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between mb-2">
                <div className="flex-1">
                  <div className="font-semibold">{opp.category}</div>
                  <div className="text-sm text-muted-foreground mt-1">{opp.description}</div>
                </div>
                <div className="text-right ml-4">
                  <div className="text-2xl font-bold text-green-600 dark:text-green-400">
                    ${opp.monthlySavings.toLocaleString()}
                  </div>
                  <div className="text-xs text-muted-foreground">per month</div>
                </div>
              </div>
              <div className="flex items-center gap-4 mt-3 text-xs">
                <div className="flex items-center gap-1">
                  <span className="text-muted-foreground">Effort:</span>
                  <span className={`font-medium capitalize ${getEffortColor(opp.effort)}`}>
                    {opp.effort}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-muted-foreground">Impact:</span>
                  <Badge variant={opp.impact === 'high' ? 'default' : 'secondary'} className="text-xs">
                    {opp.impact}
                  </Badge>
                </div>
                {opp.resources > 0 && (
                  <div className="text-muted-foreground">
                    {opp.resources} resources
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// Department Allocation Card
function DepartmentAllocationCard({ allocation }: { allocation: any[] }) {
  const COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#6366f1', '#f97316', '#06b6d4'];
  
  const pieData = allocation.map((dept, idx) => ({
    name: dept.department,
    value: dept.cost,
    color: COLORS[idx % COLORS.length],
  }));

  return (
    <Card className="hover:shadow-lg transition-shadow">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="h-5 w-5" />
          Department Cost Allocation
        </CardTitle>
        <CardDescription>Cost distribution by team</CardDescription>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={300}>
          <PieChart>
            <Pie
              data={pieData}
              cx="50%"
              cy="50%"
              labelLine={false}
              label={false}
              outerRadius={100}
              fill="#8884d8"
              dataKey="value"
            >
              {pieData.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={entry.color} />
              ))}
            </Pie>
            <Tooltip 
              contentStyle={{ 
                backgroundColor: 'hsl(var(--background))', 
                border: '1px solid hsl(var(--border))',
                borderRadius: '8px'
              }}
              formatter={(value: any) => `$${value.toLocaleString()}`}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="mt-4 space-y-2">
          {allocation.slice(0, 5).map((dept, idx) => {
            const totalCost = allocation.reduce((sum, d) => sum + d.cost, 0);
            const percentage = ((dept.cost / totalCost) * 100).toFixed(1);
            return (
              <div key={idx} className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <div 
                    className="w-3 h-3 rounded-full" 
                    style={{ backgroundColor: COLORS[idx % COLORS.length] }}
                  />
                  <span>{dept.department}</span>
                </div>
                <span className="font-medium">${dept.cost.toLocaleString()} ({percentage}%)</span>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

// Heatmap Card
function HeatmapCard({ heatmap }: { heatmap: any }) {
  const [showAllModal, setShowAllModal] = useState(false);
  
  if (!heatmap || !heatmap.services || heatmap.services.length === 0) {
    return (
      <Card className="hover:shadow-lg transition-shadow">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Calendar className="h-5 w-5" />
            Cost Allocation Heatmap
          </CardTitle>
          <CardDescription>Service × Department cost matrix</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8 text-muted-foreground">
            No heatmap data available
          </div>
        </CardContent>
      </Card>
    );
  }

  // Filter out services where all costs are 0
  const filteredData: { service: string; rowData: number[]; index: number }[] = [];
  heatmap.services.forEach((service: string, sIdx: number) => {
    const rowData = heatmap.data[sIdx];
    const hasNonZeroCost = rowData.some((value: number) => value > 0);
    if (hasNonZeroCost) {
      filteredData.push({ service, rowData, index: sIdx });
    }
  });

  if (filteredData.length === 0) {
    return (
      <Card className="hover:shadow-lg transition-shadow">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Calendar className="h-5 w-5" />
            Cost Allocation Heatmap
          </CardTitle>
          <CardDescription>Service × Department cost matrix</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8 text-muted-foreground">
            No services with costs found
          </div>
        </CardContent>
      </Card>
    );
  }

  // Sort by total cost (descending) and take top 5
  const sortedData = [...filteredData].sort((a, b) => {
    const totalA = a.rowData.reduce((sum, val) => sum + val, 0);
    const totalB = b.rowData.reduce((sum, val) => sum + val, 0);
    return totalB - totalA;
  });
  
  const top5Data = sortedData.slice(0, 4);
  const hasMore = sortedData.length > 4;

  // Find max value for color scaling (from all filtered data)
  const maxValue = Math.max(...filteredData.flatMap(item => item.rowData));

  const getHeatColor = (value: number) => {
    const intensity = value / maxValue;
    if (intensity > 0.7) return 'bg-red-500';
    if (intensity > 0.4) return 'bg-orange-500';
    if (intensity > 0.2) return 'bg-yellow-500';
    if (intensity > 0) return 'bg-green-500';
    return 'bg-muted';
  };

  return (
    <Card className="hover:shadow-lg transition-shadow">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Calendar className="h-5 w-5" />
          Cost Allocation Heatmap
        </CardTitle>
        <CardDescription>Service × Department cost matrix (showing top 4 of {filteredData.length} services)</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-card z-10">
              <tr>
                <th className="p-2 text-left font-medium bg-card">Service</th>
                {heatmap.departments.map((dept: string, idx: number) => (
                  <th key={idx} className="p-2 text-center font-medium bg-card">{dept}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {top5Data.map(({ service, rowData }, idx) => (
                <tr key={idx} className="border-t">
                  <td className="p-2 font-medium">{service}</td>
                  {heatmap.departments.map((_: string, dIdx: number) => {
                    const value = rowData[dIdx];
                    return (
                      <td key={dIdx} className="p-1">
                        <div 
                          className={`h-8 rounded flex items-center justify-center ${getHeatColor(value)}`}
                          title={`$${value.toFixed(2)}`}
                        >
                          {value > 0 && (
                            <span className="text-white text-xs font-medium">
                              ${value.toFixed(2)}
                            </span>
                          )}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        
        {hasMore && (
          <div className="mt-4 text-center">
            <Dialog open={showAllModal} onOpenChange={setShowAllModal}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm" className="gap-2">
                  <Maximize2 className="h-4 w-4" />
                  Show All {filteredData.length} Services
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-6xl max-h-[80vh] overflow-hidden flex flex-col">
                <DialogHeader>
                  <DialogTitle>Complete Cost Allocation Heatmap</DialogTitle>
                </DialogHeader>
                <div className="overflow-x-auto overflow-y-auto flex-1">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-card z-10">
                      <tr>
                        <th className="p-2 text-left font-medium bg-card">Service</th>
                        {heatmap.departments.map((dept: string, idx: number) => (
                          <th key={idx} className="p-2 text-center font-medium bg-card">{dept}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sortedData.map(({ service, rowData }, idx) => (
                        <tr key={idx} className="border-t">
                          <td className="p-2 font-medium">{service}</td>
                          {heatmap.departments.map((_: string, dIdx: number) => {
                            const value = rowData[dIdx];
                            return (
                              <td key={dIdx} className="p-1">
                                <div 
                                  className={`h-8 rounded flex items-center justify-center ${getHeatColor(value)}`}
                                  title={`${value.toFixed(2)}`}
                                >
                                  {value > 0 && (
                                    <span className="text-white text-xs font-medium">
                                      ${value.toFixed(2)}
                                    </span>
                                  )}
                                </div>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-4 flex items-center gap-2 text-xs border-t pt-4">
                  <span className="text-muted-foreground">Legend:</span>
                  <div className="flex items-center gap-1">
                    <div className="w-4 h-4 rounded bg-green-500" />
                    <span>Low</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="w-4 h-4 rounded bg-yellow-500" />
                    <span>Medium</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="w-4 h-4 rounded bg-orange-500" />
                    <span>High</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="w-4 h-4 rounded bg-red-500" />
                    <span>Very High</span>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        )}
        
        <div className="mt-4 flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Legend:</span>
          <div className="flex items-center gap-1">
            <div className="w-4 h-4 rounded bg-green-500" />
            <span>Low</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-4 h-4 rounded bg-yellow-500" />
            <span>Medium</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-4 h-4 rounded bg-orange-500" />
            <span>High</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-4 h-4 rounded bg-red-500" />
            <span>Very High</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}


// AI Spend Analysis Card
function AISpendCard({ aiSpend }: { aiSpend: any }) {
  const COLORS = ['#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#6366f1', '#f97316', '#06b6d4'];
  
  const donutData = aiSpend.aiServices.slice(0, 8).map((service: any, idx: number) => ({
    name: service.service,
    value: service.cost,
    percentage: service.percentage,
    color: COLORS[idx % COLORS.length],
  }));

  const hasAISpend = aiSpend.totalAISpend > 0;

  return (
    <Card className="hover:shadow-lg transition-shadow bg-gradient-to-br from-purple-50 to-indigo-50 dark:from-purple-950 dark:to-indigo-950">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Brain className="h-5 w-5 text-purple-600 dark:text-purple-400" />
          AI Spend Distribution
        </CardTitle>
        <CardDescription>
          {hasAISpend 
            ? `Total AI spend: $${aiSpend.totalAISpend.toLocaleString()} (${aiSpend.aiPercentageOfTotal.toFixed(1)}% of total)`
            : 'No AI services detected in this period'
          }
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!hasAISpend ? (
          <div className="text-center py-12 text-muted-foreground">
            <Brain className="h-12 w-12 mx-auto mb-3 opacity-30" />
            <p>No AI/ML services usage detected</p>
            <p className="text-xs mt-2">AI services include Bedrock, SageMaker, OpenAI, and more</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Donut Chart */}
            <div>
              <ResponsiveContainer width="100%" height={280}>
                <PieChart>
                  <Pie
                    data={donutData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={100}
                    labelLine={false}
                    label={false}
                    fill="#8884d8"
                    dataKey="value"
                  >
                    {donutData.map((entry: any, index: number) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip 
                    contentStyle={{ 
                      backgroundColor: 'hsl(var(--background))', 
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px'
                    }}
                    formatter={(value: any, name: string, props: any) => {
                      return [`$${value.toLocaleString()} (${props.payload.percentage.toFixed(1)}%)`, props.payload.name];
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="text-center -mt-2">
                <div className="text-2xl font-bold text-purple-600 dark:text-purple-400">
                  ${aiSpend.totalAISpend.toLocaleString()}
                </div>
                <div className="text-xs text-muted-foreground">Total AI Spend</div>
              </div>
            </div>

            {/* Service List */}
            <div className="space-y-2">
              <div className="text-sm font-medium mb-3">Top AI Services</div>
              {aiSpend.aiServices.slice(0, 8).map((service: any, idx: number) => (
                <div key={idx} className="flex items-center justify-between p-2 rounded-lg bg-white/50 dark:bg-gray-800/50">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <div 
                      className="w-3 h-3 rounded-full flex-shrink-0" 
                      style={{ backgroundColor: COLORS[idx % COLORS.length] }}
                    />
                    <span className="text-sm truncate">{service.service}</span>
                  </div>
                  <div className="text-right ml-2">
                    <div className="text-sm font-bold">${service.cost.toLocaleString()}</div>
                    <div className="text-xs text-muted-foreground">{service.percentage.toFixed(1)}%</div>
                  </div>
                </div>
              ))}
              
              {aiSpend.topAIService !== 'None' && (
                <div className="mt-4 p-3 rounded-lg bg-purple-100 dark:bg-purple-900/30 border border-purple-200 dark:border-purple-800">
                  <div className="text-xs text-muted-foreground mb-1">Top AI Service</div>
                  <div className="font-semibold text-purple-700 dark:text-purple-300">
                    {aiSpend.topAIService}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
