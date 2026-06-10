import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { AreaChart, Area, ResponsiveContainer } from "recharts";
import { Server, Lightbulb, Clock } from "lucide-react";

interface AccountSummary {
  id: number;
  accountName: string;
  accountId: string;
  isActive: boolean;
  lastSyncAt: string | null;
  cost: number;
  percentage: number;
  serviceCount: number;
  topService: { name: string; cost: number } | null;
  dailyTrend: Array<{ date: string; cost: number }>;
  findingsCount: number;
}

interface AccountSummaryResponse {
  success: boolean;
  multiAccount: boolean;
  awsTotal: number;
  accounts: AccountSummary[];
}

function relativeTime(iso: string | null): string {
  if (!iso) return "never synced";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "never synced";
  const diffMs = Date.now() - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function AwsAccountsSection({ startDate, endDate }: { startDate: string; endDate: string }) {
  const { data, isLoading } = useQuery<AccountSummaryResponse>({
    queryKey: ["/api/aws/account-summaries", startDate, endDate],
    queryFn: async () => {
      const params = new URLSearchParams({ startDate, endDate });
      const res = await fetch(`/api/aws/account-summaries?${params.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch AWS account summaries");
      return res.json();
    },
  });

  // Only render this section when there are multiple AWS accounts.
  if (isLoading) {
    return <Skeleton className="h-48 w-full" />;
  }
  if (!data?.multiAccount || !data.accounts?.length) {
    return null;
  }

  return (
    <Card data-testid="section-aws-accounts">
      <CardHeader>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <CardTitle className="text-lg font-semibold">AWS Accounts ({data.accounts.length})</CardTitle>
            <CardDescription>Cost split across your linked AWS accounts for this period</CardDescription>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold">${data.awsTotal.toFixed(2)}</div>
            <div className="text-xs text-muted-foreground">total AWS spend</div>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {data.accounts.map((acc) => (
            <div
              key={acc.id}
              className="rounded-lg border bg-card p-4 space-y-3"
              data-testid={`aws-account-${acc.accountId}`}
            >
              {/* Header: name + id + status */}
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold truncate">{acc.accountName}</div>
                  <div className="text-xs text-muted-foreground font-mono truncate">{acc.accountId}</div>
                </div>
                <Badge variant={acc.isActive ? "default" : "outline"} className="shrink-0">
                  {acc.isActive ? "Active" : "Inactive"}
                </Badge>
              </div>

              {/* Cost + share */}
              <div className="flex items-end justify-between gap-2">
                <div>
                  <div className="text-2xl font-bold">${acc.cost.toFixed(2)}</div>
                  <div className="text-xs text-muted-foreground">{acc.percentage.toFixed(1)}% of AWS</div>
                </div>
                {acc.dailyTrend.length > 1 && (
                  <div className="h-10 w-28">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={acc.dailyTrend}>
                        <Area
                          type="monotone"
                          dataKey="cost"
                          stroke="hsl(var(--chart-1))"
                          fill="hsl(var(--chart-1))"
                          fillOpacity={0.2}
                          strokeWidth={1.5}
                          dot={false}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>

              {/* Details */}
              <div className="space-y-1.5 text-sm border-t pt-3">
                {acc.topService ? (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground flex items-center gap-1.5">
                      <Server className="h-3.5 w-3.5" /> Top service
                    </span>
                    <span className="font-medium truncate">
                      {acc.topService.name} <span className="text-muted-foreground">(${acc.topService.cost.toFixed(0)})</span>
                    </span>
                  </div>
                ) : (
                  <div className="text-xs text-muted-foreground">{acc.isActive ? "No cost recorded this period" : "Sync disabled"}</div>
                )}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Services</span>
                  <span className="font-medium">{acc.serviceCount}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground flex items-center gap-1.5">
                    <Lightbulb className="h-3.5 w-3.5" /> Optimization findings
                  </span>
                  <span className="font-medium">{acc.findingsCount}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground flex items-center gap-1.5">
                    <Clock className="h-3.5 w-3.5" /> Last synced
                  </span>
                  <span className="font-medium">{relativeTime(acc.lastSyncAt)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
