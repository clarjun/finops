import { LayoutDashboard, MessageSquare, TrendingUp, DollarSign, Lightbulb, Brain, Settings, Cloud, FileText, Calculator, Users, ScrollText } from "lucide-react";
import { Link, useLocation } from "wouter";
import { useAuth, type Permission } from "@/hooks/use-auth";
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
  { title: "Dashboard",      url: "/",              icon: LayoutDashboard },
  { title: "Reports",        url: "/reports",       icon: FileText },
  { title: "AI Query",       url: "/ai-query",      icon: MessageSquare },
  { title: "Cost Estimator", url: "/cost-estimator",icon: Calculator },
  { title: "Forecast",       url: "/forecast",      icon: TrendingUp },
  { title: "Budgets",        url: "/budgets",       icon: DollarSign },
  { title: "Optimization",   url: "/optimization",  icon: Lightbulb },
  { title: "AI Agent",       url: "/agent",         icon: Brain },
  { title: "Configuration",  url: "/configuration", icon: Cloud },
];

/**
 * Nav entries gated on a specific permission rather than a broad "isAdmin"
 * flag, so the menu matches what the API will actually allow. Showing a link
 * that 403s is worse than not showing it.
 */
const permissionedMenuItems: Array<{ title: string; url: string; icon: typeof Users; permission: Permission }> = [
  { title: "User Management", url: "/users", icon: Users, permission: 'user:manage' },
  { title: "Audit Log", url: "/audit", icon: ScrollText, permission: 'audit:read' },
];

export function AppSidebar() {
  const [location] = useLocation();
  const { can } = useAuth();

  const allItems = [
    ...menuItems,
    ...permissionedMenuItems.filter(item => can(item.permission)),
  ];

  return (
    <Sidebar>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="text-xs font-semibold tracking-wide uppercase text-muted-foreground px-3">
            <div style={{ textAlign: "center", paddingTop: "100px", paddingLeft: "20px" }}>
              <img
                src="/assets/logo.png"
                alt="Company Logo"
                style={{ width: "150px", height: "auto", borderRadius: "8px", boxShadow: "0 0 10px rgba(0,0,0,0.1)" }}
              />
            </div>
          </SidebarGroupLabel>
          <SidebarGroupContent className="mt-28">
            <SidebarMenu>
              {allItems.map((item) => {
                const isActive = location === item.url;
                return (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton asChild isActive={isActive} data-testid={`nav-${item.title.toLowerCase().replace(/ /g, '-')}`}>
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
