import { NavLink } from "react-router-dom";
import { LayoutDashboard, Users, Settings } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

type NavItem = {
  to: string;
  icon: LucideIcon;
  label: string;
};

const navItems: NavItem[] = [
  { to: "/dashboard", icon: LayoutDashboard, label: "数据概览" },
  { to: "/accounts", icon: Users, label: "账号管理" },
  { to: "/settings", icon: Settings, label: "系统设置" },
];

export function AppSidebar() {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex h-12 items-center gap-2 px-2">
          <img src="/favicon.ico" alt="JoyCode" className="size-6 shrink-0" />
          <span className="group-data-[collapsible=icon]:hidden text-sm font-semibold truncate">
            JoyCode 代理
          </span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarMenu>
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <SidebarMenuItem key={item.to}>
                <SidebarMenuButton asChild tooltip={item.label}>
                  <NavLink
                    to={item.to}
                    className={({ isActive }) =>
                      isActive
                        ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                        : undefined
                    }
                  >
                    <Icon />
                    <span>{item.label}</span>
                  </NavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarContent>
    </Sidebar>
  );
}

export default AppSidebar;
