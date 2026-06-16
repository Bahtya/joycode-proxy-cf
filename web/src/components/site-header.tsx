import { LogOut, CheckCircle2, AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SidebarTrigger } from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { APP_VERSION } from "@/version";

type SiteHeaderProps = {
  healthy: boolean;
  accountCount: number;
  onLogout: () => void;
};

export function SiteHeader({
  healthy,
  accountCount,
  onLogout,
}: SiteHeaderProps) {
  return (
    <header className="flex h-14 items-center gap-2 border-b px-4">
      <SidebarTrigger className="lg:hidden" />
      <Badge variant={healthy ? "default" : "destructive"}>
        {healthy ? (
          <CheckCircle2 className="size-3" />
        ) : (
          <AlertTriangle className="size-3" />
        )}
        {healthy ? "服务正常" : "服务异常"}
      </Badge>
      <span className="hidden sm:inline text-sm text-muted-foreground">
        {accountCount} 个账号在线
      </span>

      <div className="ml-auto flex items-center gap-3">
        <span className="text-xs text-muted-foreground/70 tabular-nums">
          v{APP_VERSION}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={onLogout}
              aria-label="退出登录"
            >
              <LogOut />
            </Button>
          </TooltipTrigger>
          <TooltipContent>退出登录</TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}

export default SiteHeader;
