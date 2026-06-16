import { useEffect, useState } from "react";
import { Outlet, useNavigate } from "react-router-dom";

import { api, clearToken } from "@/api";
import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import useDocumentTitle from "@/hooks/useDocumentTitle";
import { TzProvider } from "@/lib/tz";

const COLLAPSED_KEY = "joycode_sider_collapsed";

export default function MainLayout() {
  useDocumentTitle();
  const navigate = useNavigate();

  const [open, setOpen] = useState(
    () => localStorage.getItem(COLLAPSED_KEY) !== "true"
  );
  const [healthy, setHealthy] = useState(true);
  const [accountCount, setAccountCount] = useState(0);

  useEffect(() => {
    api
      .getHealth()
      .then((h) => {
        setHealthy(h.status === "ok");
        setAccountCount(h.accounts);
      })
      .catch(() => setHealthy(false));
  }, []);

  const handleOpenChange = (value: boolean) => {
    setOpen(value);
    localStorage.setItem(COLLAPSED_KEY, value ? "false" : "true");
  };

  const handleLogout = () => {
    clearToken();
    navigate("/login");
  };

  return (
    <TzProvider>
    <SidebarProvider defaultOpen={open} onOpenChange={handleOpenChange}>
      <AppSidebar />
      <SidebarInset>
        <SiteHeader
          healthy={healthy}
          accountCount={accountCount}
          onLogout={handleLogout}
        />
        <main className="flex-1 p-3 md:p-6">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
    </TzProvider>
  );
}
