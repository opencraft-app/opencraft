"use client";

import { usePathname } from "next/navigation";
import { Menu, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/components/auth-provider";

const pageTitles: Record<string, string> = {
  "/dashboard": "概览",
  "/provision": "开通",
  "/users": "用户",
  "/plans": "套餐",
  "/providers": "供应商",
  "/api-keys": "密钥",
  "/routing": "路由",
  "/cache": "缓存",
  "/playground": "测试",
};

interface HeaderProps {
  onMenuClick: () => void;
}

export function Header({ onMenuClick }: HeaderProps) {
  const pathname = usePathname();
  const { logout } = useAuth();
  const title = Object.entries(pageTitles).find(([path]) =>
    pathname === path || pathname.startsWith(path + "/")
  )?.[1] ?? "概览";

  return (
    <header className="flex h-14 items-center justify-between gap-4 border-b border-border bg-background px-6">
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="icon"
          className="lg:hidden"
          onClick={onMenuClick}
        >
          <Menu className="h-5 w-5" />
        </Button>
        <h1 className="text-lg font-semibold">{title}</h1>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={logout}
      >
        <LogOut className="mr-2 h-4 w-4" />
        退出登录
      </Button>
    </header>
  );
}
