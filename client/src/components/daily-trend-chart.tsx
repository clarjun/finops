import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LineChart, Line, BarChart, Bar, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { Skeleton } from "@/components/ui/skeleton";

interface DailyTrendChartProps {
  data: Array<{
    date: string;
    cost: number;
    services: Record<string, number>;
  }>;
  services: string[];
  selectedService: string;
  onServiceChange: (service: string) => void;
  loading?: boolean;
}

export function DailyTrendChart({
  data,
  services,
  selectedService,
  onServiceChange,
  loading,
}: DailyTrendChartProps) {
  const [chartType, setChartType] = useState<'line' | 'bar' | 'area'>('line');

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-10 w-40" />
          </div>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-80 w-full" />
        </CardContent>
      </Card>
    );
  }

  const chartData = data.map((item) => ({
    date: item.date,
    cost: selectedService === "all" ? item.cost : (item.services[selectedService] || 0),
  }));

  const renderChart = () => {
    const commonProps = {
      data: chartData,
    };

    const commonAxisProps = {
      xAxis: (
        <XAxis
          dataKey="date"
          stroke="hsl(var(--muted-foreground))"
          fontSize={12}
          tickLine={false}
          axisLine={false}
        />
      ),
      yAxis: (
        <YAxis
          stroke="hsl(var(--muted-foreground))"
          fontSize={12}
          tickLine={false}
          axisLine={false}
          tickFormatter={(value) => `$${value.toFixed(0)}`}
        />
      ),
      cartesianGrid: (
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
      ),
      tooltip: (
        <Tooltip
          contentStyle={{
            backgroundColor: "hsl(var(--popover))",
            border: "1px solid hsl(var(--popover-border))",
            borderRadius: "0.5rem",
            color: "hsl(var(--popover-foreground))",
          }}
          formatter={(value: number) => [`$${value.toFixed(2)}`, "Cost"]}
          labelStyle={{ color: "hsl(var(--muted-foreground))" }}
        />
      ),
    };

    switch (chartType) {
      case 'line':
        return (
          <LineChart {...commonProps}>
            <defs>
              <linearGradient id="costGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="hsl(var(--chart-1))" stopOpacity={0.3} />
                <stop offset="95%" stopColor="hsl(var(--chart-1))" stopOpacity={0} />
              </linearGradient>
            </defs>
            {commonAxisProps.cartesianGrid}
            {commonAxisProps.xAxis}
            {commonAxisProps.yAxis}
            {commonAxisProps.tooltip}
            <Line
              type="monotone"
              dataKey="cost"
              stroke="hsl(var(--chart-1))"
              strokeWidth={3}
              dot={{ fill: "hsl(var(--chart-1))", strokeWidth: 2, r: 4 }}
              activeDot={{ r: 6 }}
              fill="url(#costGradient)"
            />
          </LineChart>
        );
      
      case 'bar':
        return (
          <BarChart {...commonProps}>
            {commonAxisProps.cartesianGrid}
            {commonAxisProps.xAxis}
            {commonAxisProps.yAxis}
            {commonAxisProps.tooltip}
            <Bar dataKey="cost" fill="hsl(var(--chart-1))" radius={[4, 4, 0, 0]} />
          </BarChart>
        );
      
      case 'area':
        return (
          <AreaChart {...commonProps}>
            <defs>
              <linearGradient id="costGradientArea" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="hsl(var(--chart-1))" stopOpacity={0.5} />
                <stop offset="95%" stopColor="hsl(var(--chart-1))" stopOpacity={0.05} />
              </linearGradient>
            </defs>
            {commonAxisProps.cartesianGrid}
            {commonAxisProps.xAxis}
            {commonAxisProps.yAxis}
            {commonAxisProps.tooltip}
            <Area
              type="monotone"
              dataKey="cost"
              stroke="hsl(var(--chart-1))"
              strokeWidth={2}
              fill="url(#costGradientArea)"
            />
          </AreaChart>
        );
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <CardTitle className="text-lg font-semibold">Daily Cost Trend</CardTitle>
          <div className="flex gap-2">
            <Select value={chartType} onValueChange={(value: any) => setChartType(value)}>
              <SelectTrigger className="w-32" data-testid="select-trend-chart-type">
                <SelectValue placeholder="Chart Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="line" data-testid="trend-chart-type-line">Line</SelectItem>
                <SelectItem value="bar" data-testid="trend-chart-type-bar">Bar</SelectItem>
                <SelectItem value="area" data-testid="trend-chart-type-area">Area</SelectItem>
              </SelectContent>
            </Select>
            <Select value={selectedService} onValueChange={onServiceChange}>
              <SelectTrigger className="w-[200px]" data-testid="select-service-filter">
                <SelectValue placeholder="Select service" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Services</SelectItem>
                {services.map((service) => (
                  <SelectItem key={service} value={service} data-testid={`option-${service.toLowerCase().replace(/\s+/g, '-')}`}>
                    {service}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="h-80" data-testid="chart-daily-trend">
          <ResponsiveContainer width="100%" height="100%">
            {renderChart()}
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
