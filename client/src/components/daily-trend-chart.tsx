import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
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

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <CardTitle className="text-lg font-semibold">Daily Cost Trend</CardTitle>
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
      </CardHeader>
      <CardContent>
        <div className="h-80" data-testid="chart-daily-trend">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData}>
              <defs>
                <linearGradient id="costGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(var(--chart-1))" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="hsl(var(--chart-1))" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
              <XAxis
                dataKey="date"
                stroke="hsl(var(--muted-foreground))"
                fontSize={12}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                stroke="hsl(var(--muted-foreground))"
                fontSize={12}
                tickLine={false}
                axisLine={false}
                tickFormatter={(value) => `$${value.toFixed(0)}`}
              />
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
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
