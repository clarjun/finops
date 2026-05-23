import { LayoutDashboard, MessageSquare, TrendingUp, DollarSign, Lightbulb, Brain, Settings, Cloud, FileText, Calculator } from "lucide-react";
import { Link, useLocation } from "wouter";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

const menuItems = [
  {
    title: "Dashboard",
    url: "/",
    icon: LayoutDashboard,
  },
  {
    title: "Reports",
    url: "/reports",
    icon: FileText,
  },
  {
    title: "AI Query",
    url: "/ai-query",
    icon: MessageSquare,
  },
  {
    title: "Cost Estimator",
    url: "/cost-estimator",
    icon: Calculator,
  },
  {
    title: "Forecast",
    url: "/forecast",
    icon: TrendingUp,
  },
  {
    title: "Budgets",
    url: "/budgets",
    icon: DollarSign,
  },
  // Alerts menu hidden - functionality consolidated into Budgets
  // {
  //   title: "Alerts",
  //   url: "/alerts",
  //   icon: Bell,
  // },
  {
    title: "Optimization",
    url: "/optimization",
    icon: Lightbulb,
  },
  {
    title: "AI Agent",
    url: "/agent",
    icon: Brain,
  },
  {
    title: "Configuration",
    url: "/configuration",
    icon: Cloud,
  },
];

export function AppSidebar() {
  const [location] = useLocation();

  return (
    <Sidebar>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="text-xs font-semibold tracking-wide uppercase text-muted-foreground px-3">
            {/* Multi-Cloud FinOps */}
            <div style={{ textAlign: "center", paddingTop: "100px", paddingLeft:"20px" }}>
              <img
                src="assets/logo.png" // ✅ Direct path from root
                alt="Company Logo"
                style={{
                  width: "150px",
                  height: "auto",
                  borderRadius: "8px",
                  boxShadow: "0 0 10px rgba(0,0,0,0.1)",
                }}
              />
              {/* <h1>Welcome to Multi Cloud Visualizer</h1> */}
            </div>
          </SidebarGroupLabel>
          <SidebarGroupContent className="mt-28">
            <SidebarMenu>
              {menuItems.map((item) => {
                const isActive = location === item.url;
                return (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton asChild isActive={isActive} data-testid={`nav-${item.title.toLowerCase().replace(' ', '-')}`}>
                      <Link href={item.url}>
                        <item.icon className="h-4 w-4" />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
