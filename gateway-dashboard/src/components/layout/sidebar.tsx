"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  BarChart3,
  Rocket,
  Users,
  Package,
  Plug,
  KeyRound,
  Zap,
  PanelLeftClose,
  PanelLeft,
  Route,
  FlaskConical,
  Database,
  ShieldCheck,
  MessageSquareMore,
  Ticket,
  Boxes,
  Bot,
  BadgeDollarSign,
  GitBranch,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const navItems = [
  { label: "概览", href: "/dashboard", icon: BarChart3 },
  { type: "separator" as const },
  { label: "用户", href: "/users", icon: Users },
  { label: "密钥", href: "/api-keys", icon: KeyRound },
  { label: "开通", href: "/provision", icon: Rocket },
  { type: "separator" as const },
  { label: "认证用户", href: "/auth-users", icon: ShieldCheck },
  { label: "验证码", href: "/sms-codes", icon: MessageSquareMore },
  { label: "邀请码", href: "/invites", icon: Ticket },
  { label: "业务订阅", href: "/subscriptions", icon: BadgeDollarSign },
  { type: "separator" as const },
  { label: "套餐", href: "/plans", icon: Package },
  { label: "供应商", href: "/providers", icon: Plug },
  { label: "路由", href: "/routing", icon: Route },
  { label: "缓存", href: "/cache", icon: Database },
  { label: "沙箱池", href: "/sandbox-pools", icon: Boxes },
  { label: "沙箱 SKU", href: "/sandbox-skus", icon: GitBranch },
  { label: "CTL Bots", href: "/ctl-bots", icon: Bot },
  { type: "separator" as const },
  { label: "测试", href: "/playground", icon: FlaskConical },
] as const;

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const pathname = usePathname();

  return (
    <TooltipProvider delay={0}>
      <aside
        className={cn(
          "flex flex-col border-r border-border bg-background transition-all duration-200",
          collapsed ? "w-16" : "w-56"
        )}
      >
        {/* Logo */}
        <div className="flex h-14 items-center gap-2 border-b border-border px-4">
          <Zap className="h-5 w-5 shrink-0 text-primary" />
          {!collapsed && (
            <span className="font-semibold text-sm">AI Gateway</span>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 space-y-1 p-2">
          {navItems.map((item, i) => {
            if ("type" in item && item.type === "separator") {
              return <Separator key={i} className="my-2" />;
            }
            if (!("href" in item)) return null;
            const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
            const Icon = item.icon;
            const linkClassName = cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
              isActive
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            );

            if (collapsed) {
              return (
                <Tooltip key={item.href}>
                  <TooltipTrigger
                    render={<Link href={item.href} className={linkClassName} />}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                  </TooltipTrigger>
                  <TooltipContent side="right">{item.label}</TooltipContent>
                </Tooltip>
              );
            }
            return (
              <Link
                key={item.href}
                href={item.href}
                className={linkClassName}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        {/* Toggle */}
        <div className="border-t border-border p-2">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-center"
            onClick={onToggle}
          >
            {collapsed ? <PanelLeft className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
          </Button>
        </div>
      </aside>
    </TooltipProvider>
  );
}
