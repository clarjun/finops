import { Switch, Route, Redirect } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { ThemeProvider } from "@/components/theme-provider";
import { ThemeToggle } from "@/components/theme-toggle";
import { AppSidebar } from "@/components/app-sidebar";
import { DateRangeProvider } from "@/contexts/date-range-context";
import { useAuth, useLogout } from "@/hooks/use-auth";
import Dashboard from "@/pages/dashboard";
import Reports from "@/pages/reports";
import AiQuery from "@/pages/ai-query";
import Forecast from "@/pages/forecast";
import Budgets from "@/pages/budgets";
import Alerts from "@/pages/alerts";
import Optimization from "@/pages/optimization";
import AgentDashboard from "@/pages/agent-dashboard";
import Configuration from "@/pages/configuration";
import Settings from "@/pages/settings";
import CostEstimator from "@/pages/cost-estimator";
import UsersPage from "@/pages/users";
import Login from "@/pages/login";
import NotFound from "@/pages/not-found";
import { Button } from "@/components/ui/button";
import { LogOut, User } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

function ProtectedRouter() {
  const { isAdmin } = useAuth();
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/reports" component={Reports} />
      <Route path="/ai-query" component={AiQuery} />
      <Route path="/cost-estimator" component={CostEstimator} />
      <Route path="/forecast" component={Forecast} />
      <Route path="/budgets" component={Budgets} />
      <Route path="/alerts" component={Alerts} />
      <Route path="/optimization" component={Optimization} />
      <Route path="/agent" component={AgentDashboard} />
      <Route path="/configuration" component={Configuration} />
      <Route path="/settings" component={Settings} />
      {/* Admin-only route */}
      <Route path="/users">
        {isAdmin ? <UsersPage /> : <Redirect to="/" />}
      </Route>
      <Route path="/login"><Redirect to="/" /></Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function PublicRouter() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route><Redirect to="/login" /></Route>
    </Switch>
  );
}

function App() {
  const style = { "--sidebar-width": "16rem", "--sidebar-width-icon": "3rem" };
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <DateRangeProvider>
            <AuthWrapper style={style} />
          </DateRangeProvider>
          <Toaster />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

function AuthWrapper({ style }: { style: Record<string, string> }) {
  const { isAuthenticated, user, isLoading } = useAuth();
  const logout = useLogout();

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-center">
          <div className="h-12 w-12 mx-auto mb-4 border-4 border-primary border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) return <PublicRouter />;

  return (
    <SidebarProvider style={style as React.CSSProperties}>
      <div className="flex h-screen w-full">
        <AppSidebar />
        <div className="flex flex-col flex-1 overflow-hidden">
          <header className="flex items-center justify-between p-4 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 sticky top-0 z-10">
            <SidebarTrigger data-testid="button-sidebar-toggle" />
            <div className="flex items-center gap-2">
              <ThemeToggle />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" data-testid="button-user-menu">
                    <User className="h-5 w-5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel>
                    <div>
                      <p className="font-medium">{user?.username}</p>
                      <p className="text-xs text-muted-foreground capitalize">{user?.role}</p>
                    </div>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => logout.mutate()} data-testid="button-logout">
                    <LogOut className="mr-2 h-4 w-4" />
                    Logout
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </header>
          <main className="flex-1 overflow-y-auto p-6 md:p-8">
            <div className="max-w-7xl mx-auto">
              <ProtectedRouter />
            </div>
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}

export default App;
