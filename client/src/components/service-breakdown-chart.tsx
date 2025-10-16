import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { Skeleton } from "@/components/ui/skeleton";

interface ServiceBreakdownChartProps {
  data: Array<{
    name: string;
    cost: number;
    percentage: number;
  }>;
  loading?: boolean;
  limit?: number;
  title?: string;
}

const COLORS = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-5))",
];

export function ServiceBreakdownChart({ data, loading, limit = 10, title = "Service Breakdown" }: ServiceBreakdownChartProps) {
  if (loading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-40" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-80 w-full" />
        </CardContent>
      </Card>
    );
  }

  const displayData = data.slice(0, limit);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg font-semibold">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-80" data-testid={`chart-${title.toLowerCase().replace(/\s+/g, '-')}`}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={displayData} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} horizontal={false} />
              <XAxis
                type="number"
                stroke="hsl(var(--muted-foreground))"
                fontSize={12}
                tickLine={false}
                axisLine={false}
                tickFormatter={(value) => `$${value.toFixed(0)}`}
              />
              <YAxis
                type="category"
                dataKey="name"
                stroke="hsl(var(--muted-foreground))"
                fontSize={12}
                tickLine={false}
                axisLine={false}
                width={120}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--popover))",
                  border: "1px solid hsl(var(--popover-border))",
                  borderRadius: "0.5rem",
                  color: "hsl(var(--popover-foreground))",
                }}
                formatter={(value: number, name: string, props: any) => [
                  `$${value.toFixed(2)} (${props.payload.percentage.toFixed(1)}%)`,
                  "Cost",
                ]}
                labelStyle={{ color: "hsl(var(--muted-foreground))" }}
              />
              <Bar dataKey="cost" radius={[0, 4, 4, 0]}>
                {displayData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
