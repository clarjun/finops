import { LayoutDashboard, MessageSquare, TrendingUp, DollarSign, Bell, Lightbulb, Settings } from "lucide-react";
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
    title: "AI Query",
    url: "/ai-query",
    icon: MessageSquare,
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
  {
    title: "Alerts",
    url: "/alerts",
    icon: Bell,
  },
  {
    title: "Optimization",
    url: "/optimization",
    icon: Lightbulb,
  },
  {
    title: "Settings",
    url: "/settings",
    icon: Settings,
  },
];

export function AppSidebar() {
  const [location] = useLocation();

  return (
    <Sidebar>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="text-xs font-semibold tracking-wide uppercase text-muted-foreground px-3">
            Multi-Cloud FinOps
          </SidebarGroupLabel>
          <SidebarGroupContent className="mt-4">
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
