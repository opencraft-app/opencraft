# Gateway Dashboard Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an admin dashboard (Next.js 15 + shadcn/ui) for the AI Gateway SaaS, providing account overview, one-click provisioning, and CRUD management of users, plans, providers, and API keys.

**Architecture:** Next.js App Router with a BFF proxy layer that injects Admin Token server-side. All API calls go through `/api/[...path]` catch-all route to the Go backend. React Query manages server state. shadcn/ui provides dark-themed components. No global state store.

**Tech Stack:** Next.js 15, React 19, shadcn/ui, Tailwind CSS 4, @tanstack/react-query 5, @tanstack/react-table 8, recharts, nuqs, react-hook-form, zod, sonner, lucide-react

**Spec:** `docs/superpowers/specs/2026-03-17-gateway-dashboard-design.md`

**Project Conventions:**
- **Monorepo structure**: `gateway-dashboard/` is a separate module inside `mono/` repo, alongside `ai-gateway/`.
- **All pages are client components** (`"use client"`) — no SSR data fetching, React Query handles everything.
- **API responses follow standard envelope**: `{ "items": T[], "total": number, "page": number, "page_size": number }` for paginated lists.

---

## File Map

```
gateway-dashboard/
├── src/
│   ├── app/
│   │   ├── layout.tsx                         -- Root layout: dark theme, QueryProvider, sidebar shell
│   │   ├── page.tsx                           -- / → redirect to /dashboard
│   │   ├── dashboard/page.tsx                 -- Account overview + stats + charts
│   │   ├── provision/page.tsx                 -- One-click provisioning form
│   │   ├── users/page.tsx                     -- User list table
│   │   ├── users/[id]/page.tsx                -- User detail (sub + keys + usage)
│   │   ├── plans/page.tsx                     -- Plan management table
│   │   ├── providers/page.tsx                 -- Provider management table
│   │   ├── api-keys/page.tsx                  -- API Key list table
│   │   └── api/[...path]/route.ts             -- BFF catch-all proxy to Go backend
│   ├── components/
│   │   ├── layout/
│   │   │   ├── sidebar.tsx                    -- Sidebar navigation with collapsible behavior
│   │   │   ├── header.tsx                     -- Top bar with breadcrumbs
│   │   │   ├── shell.tsx                      -- Page shell: sidebar + header + content area
│   │   │   └── error-boundary.tsx             -- Auth error full-page state
│   │   ├── dashboard/
│   │   │   ├── provider-overview.tsx           -- Provider quota progress bars
│   │   │   ├── token-pool.tsx                 -- Token resource pool 3-card summary
│   │   │   ├── user-overview.tsx              -- User distribution bar
│   │   │   ├── stats-cards.tsx                -- 4-column operational stat cards
│   │   │   ├── token-chart.tsx                -- Token consumption trend line chart
│   │   │   └── model-distribution.tsx         -- Model call donut chart
│   │   ├── provision/
│   │   │   └── provision-form.tsx             -- Provision form + result card
│   │   └── shared/
│   │       ├── data-table.tsx                 -- Generic data table (tanstack/table)
│   │       ├── confirm-dialog.tsx             -- Reusable confirm action dialog
│   │       └── page-header.tsx                -- Page title + description component
│   ├── lib/
│   │   ├── api-client.ts                     -- Fetch wrapper with error handling + auth error detection
│   │   ├── queries/
│   │   │   ├── use-stats.ts                  -- Dashboard stats, token-pool, trend hooks
│   │   │   ├── use-provision.ts              -- Provision mutation hook
│   │   │   ├── use-users.ts                  -- User CRUD + usage hooks
│   │   │   ├── use-plans.ts                  -- Plan CRUD hooks
│   │   │   ├── use-providers.ts              -- Provider CRUD + usage hooks
│   │   │   └── use-api-keys.ts               -- API Key list + revoke hooks
│   │   └── utils.ts                          -- Formatters (tokens, dates, percentages), constants
│   └── styles/
│       └── globals.css                       -- Tailwind base + shadcn dark theme CSS variables
├── public/
│   └── favicon.ico
├── .env.example
├── .gitignore
├── next.config.ts
├── tailwind.config.ts
├── tsconfig.json
├── postcss.config.mjs
├── package.json
├── Dockerfile
└── components.json                            -- shadcn/ui config
```

---

## Task 1: Project Scaffolding

**Depends on:** nothing
**Files:**
- Create: `gateway-dashboard/package.json`
- Create: `gateway-dashboard/next.config.ts`
- Create: `gateway-dashboard/tailwind.config.ts`
- Create: `gateway-dashboard/postcss.config.mjs`
- Create: `gateway-dashboard/tsconfig.json`
- Create: `gateway-dashboard/.env.example`
- Create: `gateway-dashboard/.gitignore`
- Create: `gateway-dashboard/components.json`
- Create: `gateway-dashboard/src/styles/globals.css`
- Create: `gateway-dashboard/src/app/layout.tsx`
- Create: `gateway-dashboard/src/app/page.tsx`

- [ ] **Step 1: Create Next.js project**

```bash
cd /Users/yanan/work/mono
npx create-next-app@latest gateway-dashboard \
  --typescript --tailwind --eslint --app --src-dir \
  --import-alias "@/*" --no-turbopack
```

- [ ] **Step 2: Set standalone output in next.config.ts**

Replace `gateway-dashboard/next.config.ts`:

```typescript
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
};

export default nextConfig;
```

- [ ] **Step 3: Create .env.example**

Create `gateway-dashboard/.env.example`:

```
GATEWAY_API_URL=http://localhost:8080
ADMIN_TOKEN=your-admin-token-here
```

- [ ] **Step 4: Install core dependencies**

```bash
cd /Users/yanan/work/mono/gateway-dashboard
npm install @tanstack/react-query @tanstack/react-table recharts nuqs react-hook-form @hookform/resolvers zod sonner lucide-react
```

- [ ] **Step 5: Initialize shadcn/ui**

```bash
cd /Users/yanan/work/mono/gateway-dashboard
npx shadcn@latest init -d
```

This creates `components.json` and sets up the shadcn/ui configuration. Select "New York" style, "Zinc" base color, and CSS variables for colors.

- [ ] **Step 6: Install shadcn/ui components**

```bash
cd /Users/yanan/work/mono/gateway-dashboard
npx shadcn@latest add alert-dialog button card dialog dropdown-menu form input label select separator sheet skeleton table badge tabs toast progress tooltip
```

- [ ] **Step 7: Install shadcn/ui chart component**

```bash
cd /Users/yanan/work/mono/gateway-dashboard
npx shadcn@latest add chart
```

- [ ] **Step 8: Configure dark theme in globals.css**

Edit `gateway-dashboard/src/styles/globals.css` (or `src/app/globals.css` depending on where create-next-app placed it). Add to the existing file — ensure the dark theme variables from shadcn are present, and add `dark` class to `<html>` by default. The shadcn init should have created the CSS variables. Verify `@layer base` has `:root` and `.dark` selectors with zinc-based palette values.

- [ ] **Step 9: Set dark mode in layout.tsx**

Edit `gateway-dashboard/src/app/layout.tsx` — add `className="dark"` to the `<html>` tag and wrap children with React Query provider:

```tsx
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { QueryProvider } from "@/components/query-provider";
import { Toaster } from "@/components/ui/sonner";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "AI Gateway Dashboard",
  description: "Admin dashboard for AI Gateway",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className={inter.className}>
        <QueryProvider>
          {children}
          <Toaster />
        </QueryProvider>
      </body>
    </html>
  );
}
```

- [ ] **Step 10: Create QueryProvider component**

Create `gateway-dashboard/src/components/query-provider.tsx`:

```tsx
"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5 * 60 * 1000, // 5 min default
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  );
}
```

- [ ] **Step 11: Create root page redirect**

Replace `gateway-dashboard/src/app/page.tsx`:

```tsx
import { redirect } from "next/navigation";

export default function Home() {
  redirect("/dashboard");
}
```

- [ ] **Step 12: Verify dev server starts**

```bash
cd /Users/yanan/work/mono/gateway-dashboard && npm run dev
```

Open `http://localhost:3000` — should redirect to `/dashboard` (404 is expected since that page doesn't exist yet). The important thing is no build errors.

- [ ] **Step 13: Verify production build**

```bash
cd /Users/yanan/work/mono/gateway-dashboard && npm run build
```

Expected: Build succeeds. `.next/standalone` directory is created.

- [ ] **Step 14: Commit**

```bash
cd /Users/yanan/work/mono
git add gateway-dashboard/
git commit -m "feat(gateway-dashboard): scaffold Next.js project with shadcn/ui dark theme"
```

---

## Task 2: BFF Proxy Layer & API Client

**Depends on:** Task 1
**Files:**
- Create: `gateway-dashboard/src/app/api/[...path]/route.ts`
- Create: `gateway-dashboard/src/lib/api-client.ts`
- Create: `gateway-dashboard/src/components/layout/error-boundary.tsx`

- [ ] **Step 1: Create BFF proxy route**

Create `gateway-dashboard/src/app/api/[...path]/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";

const GATEWAY_API_URL = process.env.GATEWAY_API_URL;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

async function proxyRequest(req: NextRequest, params: { path: string[] }) {
  if (!ADMIN_TOKEN) {
    return NextResponse.json(
      { error: "ADMIN_TOKEN not configured" },
      { status: 500 }
    );
  }

  const path = params.path.join("/");
  const url = new URL(`/${path}`, GATEWAY_API_URL);

  // Forward query params
  req.nextUrl.searchParams.forEach((value, key) => {
    url.searchParams.set(key, value);
  });

  const headers: HeadersInit = {
    Authorization: `Bearer ${ADMIN_TOKEN}`,
    "Content-Type": "application/json",
  };

  const fetchOptions: RequestInit = {
    method: req.method,
    headers,
  };

  // Forward body for non-GET requests
  if (req.method !== "GET" && req.method !== "HEAD") {
    const body = await req.text();
    if (body) {
      fetchOptions.body = body;
    }
  }

  try {
    const response = await fetch(url.toString(), fetchOptions);
    const data = await response.text();

    return new NextResponse(data, {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("Content-Type") || "application/json",
      },
    });
  } catch (error) {
    console.error("BFF proxy error:", error);
    return NextResponse.json(
      { error: "Gateway backend is unreachable" },
      { status: 502 }
    );
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxyRequest(req, await params);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxyRequest(req, await params);
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxyRequest(req, await params);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxyRequest(req, await params);
}
```

- [ ] **Step 2: Create API client**

Create `gateway-dashboard/src/lib/api-client.ts`:

```typescript
export class ApiError extends Error {
  status: number;
  data: unknown;

  constructor(status: number, data: unknown) {
    const message = typeof data === "object" && data !== null && "error" in data
      ? String((data as { error: string }).error)
      : `API error ${status}`;
    super(message);
    this.status = status;
    this.data = data;
    this.name = "ApiError";
  }

  get isAuthError() {
    return this.status === 401 || this.status === 403;
  }

  get isConfigError() {
    return this.status === 500 && this.message === "ADMIN_TOKEN not configured";
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  params?: Record<string, string | number | undefined>;
}

export async function apiClient<T>(
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  const { method = "GET", body, params } = options;

  const url = new URL(`/api/${path}`, window.location.origin);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    });
  }

  const fetchOptions: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };

  if (body !== undefined) {
    fetchOptions.body = JSON.stringify(body);
  }

  const response = await fetch(url.toString(), fetchOptions);

  if (!response.ok) {
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      data = { error: response.statusText };
    }
    throw new ApiError(response.status, data);
  }

  return response.json() as Promise<T>;
}
```

- [ ] **Step 3: Create error boundary component**

Create `gateway-dashboard/src/components/layout/error-boundary.tsx`:

```tsx
"use client";

import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ErrorBoundaryProps {
  error: Error;
  reset?: () => void;
}

export function AuthErrorPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="text-center space-y-4 max-w-md px-4">
        <AlertTriangle className="mx-auto h-12 w-12 text-destructive" />
        <h1 className="text-2xl font-bold text-foreground">Configuration Error</h1>
        <p className="text-muted-foreground">
          Admin Token is invalid or expired. Check the <code className="text-sm bg-muted px-1 py-0.5 rounded">ADMIN_TOKEN</code> environment variable and restart the dashboard.
        </p>
      </div>
    </div>
  );
}

export function ErrorDisplay({ error, reset }: ErrorBoundaryProps) {
  return (
    <div className="flex flex-col items-center justify-center py-12 space-y-4">
      <AlertTriangle className="h-8 w-8 text-destructive" />
      <p className="text-muted-foreground">{error.message}</p>
      {reset && (
        <Button variant="outline" onClick={reset}>
          Try Again
        </Button>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Verify build**

```bash
cd /Users/yanan/work/mono/gateway-dashboard && npm run build
```

Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
cd /Users/yanan/work/mono
git add gateway-dashboard/src/app/api/ gateway-dashboard/src/lib/api-client.ts gateway-dashboard/src/components/layout/error-boundary.tsx
git commit -m "feat(gateway-dashboard): add BFF proxy layer and API client with error handling"
```

---

## Task 3: Layout Shell (Sidebar + Header)

**Depends on:** Task 1
**Files:**
- Create: `gateway-dashboard/src/components/layout/sidebar.tsx`
- Create: `gateway-dashboard/src/components/layout/header.tsx`
- Create: `gateway-dashboard/src/components/layout/shell.tsx`
- Modify: `gateway-dashboard/src/app/layout.tsx`

- [ ] **Step 1: Create sidebar component**

Create `gateway-dashboard/src/components/layout/sidebar.tsx`:

```tsx
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
  { label: "Dashboard", href: "/dashboard", icon: BarChart3 },
  { label: "Provision", href: "/provision", icon: Rocket },
  { type: "separator" as const },
  { label: "Users", href: "/users", icon: Users },
  { label: "Plans", href: "/plans", icon: Package },
  { label: "Providers", href: "/providers", icon: Plug },
  { label: "API Keys", href: "/api-keys", icon: KeyRound },
] as const;

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const pathname = usePathname();

  return (
    <TooltipProvider delayDuration={0}>
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
            const link = (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                  isActive
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {!collapsed && <span>{item.label}</span>}
              </Link>
            );

            if (collapsed) {
              return (
                <Tooltip key={item.href}>
                  <TooltipTrigger asChild>{link}</TooltipTrigger>
                  <TooltipContent side="right">{item.label}</TooltipContent>
                </Tooltip>
              );
            }
            return link;
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
```

- [ ] **Step 2: Create header component**

Create `gateway-dashboard/src/components/layout/header.tsx`:

```tsx
"use client";

import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";

const pageTitles: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/provision": "Provision",
  "/users": "Users",
  "/plans": "Plans",
  "/providers": "Providers",
  "/api-keys": "API Keys",
};

interface HeaderProps {
  onMenuClick: () => void;
}

export function Header({ onMenuClick }: HeaderProps) {
  const pathname = usePathname();
  const title = Object.entries(pageTitles).find(([path]) =>
    pathname === path || pathname.startsWith(path + "/")
  )?.[1] ?? "Dashboard";

  return (
    <header className="flex h-14 items-center gap-4 border-b border-border bg-background px-6">
      <Button
        variant="ghost"
        size="icon"
        className="lg:hidden"
        onClick={onMenuClick}
      >
        <Menu className="h-5 w-5" />
      </Button>
      <h1 className="text-lg font-semibold">{title}</h1>
    </header>
  );
}
```

- [ ] **Step 3: Create shell component**

Create `gateway-dashboard/src/components/layout/shell.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Sidebar } from "./sidebar";
import { Header } from "./header";
import { Sheet, SheetContent } from "@/components/ui/sheet";

export function Shell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Desktop sidebar */}
      <div className="hidden lg:flex">
        <Sidebar collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />
      </div>

      {/* Mobile sidebar */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-56 p-0">
          <Sidebar collapsed={false} onToggle={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>

      {/* Main content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header onMenuClick={() => setMobileOpen(true)} />
        <main className="flex-1 overflow-y-auto p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Integrate shell into layout**

Replace `gateway-dashboard/src/app/layout.tsx`:

```tsx
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { QueryProvider } from "@/components/query-provider";
import { Shell } from "@/components/layout/shell";
import { Toaster } from "@/components/ui/sonner";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "AI Gateway Dashboard",
  description: "Admin dashboard for AI Gateway",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className={inter.className}>
        <QueryProvider>
          <Shell>{children}</Shell>
          <Toaster />
        </QueryProvider>
      </body>
    </html>
  );
}
```

- [ ] **Step 5: Create placeholder dashboard page**

Create `gateway-dashboard/src/app/dashboard/page.tsx`:

```tsx
export default function DashboardPage() {
  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Dashboard</h2>
      <p className="text-muted-foreground">Coming soon...</p>
    </div>
  );
}
```

- [ ] **Step 6: Verify dev server — sidebar + layout visible**

```bash
cd /Users/yanan/work/mono/gateway-dashboard && npm run dev
```

Open `http://localhost:3000`. Should see dark sidebar with nav items, header with "Dashboard" title, and placeholder content. Click sidebar links — active state should highlight.

- [ ] **Step 7: Verify build**

```bash
cd /Users/yanan/work/mono/gateway-dashboard && npm run build
```

Expected: Build succeeds.

- [ ] **Step 8: Commit**

```bash
cd /Users/yanan/work/mono
git add gateway-dashboard/src/components/layout/ gateway-dashboard/src/app/layout.tsx gateway-dashboard/src/app/dashboard/
git commit -m "feat(gateway-dashboard): add layout shell with sidebar navigation and header"
```

---

## Task 4: Shared Components & Utility Functions

**Depends on:** Task 1
**Files:**
- Create: `gateway-dashboard/src/components/shared/page-header.tsx`
- Create: `gateway-dashboard/src/components/shared/data-table.tsx`
- Create: `gateway-dashboard/src/components/shared/confirm-dialog.tsx`
- Create: `gateway-dashboard/src/lib/utils.ts` (extend existing)

- [ ] **Step 1: Create page header component**

Create `gateway-dashboard/src/components/shared/page-header.tsx`:

```tsx
interface PageHeaderProps {
  title: string;
  description?: string;
  children?: React.ReactNode; // Action buttons slot
}

export function PageHeader({ title, description, children }: PageHeaderProps) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">{title}</h2>
        {description && (
          <p className="text-muted-foreground">{description}</p>
        )}
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Create generic data table**

Create `gateway-dashboard/src/components/shared/data-table.tsx`:

```tsx
"use client";

import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronLeft, ChevronRight } from "lucide-react";

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  total?: number;
  page?: number;
  pageSize?: number;
  onPageChange?: (page: number) => void;
  isLoading?: boolean;
}

export function DataTable<TData, TValue>({
  columns,
  data,
  total = 0,
  page = 1,
  pageSize = 20,
  onPageChange,
  isLoading,
}: DataTableProps<TData, TValue>) {
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const totalPages = Math.ceil(total / pageSize);

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center">
                  No results.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && onPageChange && (
        <div className="flex items-center justify-between py-4">
          <p className="text-sm text-muted-foreground">
            {total} total · Page {page} of {totalPages}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onPageChange(page - 1)}
              disabled={page <= 1}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onPageChange(page + 1)}
              disabled={page >= totalPages}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Create confirm dialog**

Create `gateway-dashboard/src/components/shared/confirm-dialog.tsx`:

```tsx
"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  variant?: "default" | "destructive";
  onConfirm: () => void;
  loading?: boolean;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  variant = "default",
  onConfirm,
  loading,
}: ConfirmDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={loading}
            className={variant === "destructive" ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : ""}
          >
            {loading ? "Processing..." : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
```

Note: `alert-dialog` is already installed in Task 1 Step 6.

- [ ] **Step 4: Extend utils.ts**

Edit `gateway-dashboard/src/lib/utils.ts` — add to existing content (shadcn puts `cn` here):

```typescript
// Append after existing cn() function:

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return tokens.toString();
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat().format(n);
}

export function formatDate(date: string): string {
  return new Date(date).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatDateTime(date: string): string {
  return new Date(date).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatPercentChange(pct: number): string {
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

export function quotaColor(used: number, total: number): string {
  const pct = total > 0 ? (used / total) * 100 : 0;
  if (pct >= 95) return "text-red-500";
  if (pct >= 80) return "text-yellow-500";
  return "text-green-500";
}

export function quotaProgressColor(used: number, total: number): string {
  const pct = total > 0 ? (used / total) * 100 : 0;
  if (pct >= 95) return "bg-red-500";
  if (pct >= 80) return "bg-yellow-500";
  return "bg-green-500";
}

export function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "active": return "default";
    case "exhausted": return "destructive";
    case "disabled":
    case "deleted":
    case "expired": return "secondary";
    default: return "outline";
  }
}
```

- [ ] **Step 5: Verify build**

```bash
cd /Users/yanan/work/mono/gateway-dashboard && npm run build
```

Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
cd /Users/yanan/work/mono
git add gateway-dashboard/src/components/shared/ gateway-dashboard/src/lib/utils.ts
git commit -m "feat(gateway-dashboard): add shared components (data-table, confirm-dialog, page-header) and utils"
```

---

## Task 5: React Query Hooks

**Depends on:** Task 2 (api-client)
**Files:**
- Create: `gateway-dashboard/src/lib/queries/use-stats.ts`
- Create: `gateway-dashboard/src/lib/queries/use-provision.ts`
- Create: `gateway-dashboard/src/lib/queries/use-users.ts`
- Create: `gateway-dashboard/src/lib/queries/use-plans.ts`
- Create: `gateway-dashboard/src/lib/queries/use-providers.ts`
- Create: `gateway-dashboard/src/lib/queries/use-api-keys.ts`

- [ ] **Step 1: Create stats hooks**

Create `gateway-dashboard/src/lib/queries/use-stats.ts`:

```typescript
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";

interface UsageStats {
  total_tokens: number;
  total_requests: number;
  tokens_change_pct: number;
  requests_change_pct: number;
}

interface UserStats {
  total: number;
  active: number;
  disabled: number;
  expired: number;
}

interface TokenPool {
  total_distributed: number;
  total_consumed: number;
  global_remaining: number;
  consumed_change_7d_pct: number;
}

interface TrendDataPoint {
  date: string;
  total_tokens: number;
  total_requests: number;
}

interface ModelDistribution {
  model: string;
  tokens: number;
  requests: number;
}

interface UsageTrend {
  period: string;
  granularity: string;
  data: TrendDataPoint[];
  model_distribution: ModelDistribution[];
}

export function useUsageStats() {
  return useQuery({
    queryKey: ["stats", "usage"],
    queryFn: () => apiClient<UsageStats>("admin/stats/usage"),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}

export function useUserStats() {
  return useQuery({
    queryKey: ["stats", "users"],
    queryFn: () => apiClient<UserStats>("admin/stats/users"),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}

export function useTokenPool() {
  return useQuery({
    queryKey: ["stats", "token-pool"],
    queryFn: () => apiClient<TokenPool>("admin/stats/token-pool"),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}

export function useUsageTrend(period: "7d" | "30d" = "7d") {
  return useQuery({
    queryKey: ["stats", "usage-trend", period],
    queryFn: () =>
      apiClient<UsageTrend>("admin/stats/usage/trend", {
        params: { period, granularity: "daily" },
      }),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}
```

- [ ] **Step 2: Create provision hook**

Create `gateway-dashboard/src/lib/queries/use-provision.ts`:

```typescript
import { useMutation } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";

interface ProvisionRequest {
  phone: string;
  external_uid?: string;
  plan_name: string;
}

interface ProvisionResponse {
  user_id: string;
  api_key: string;
  plan_name: string;
  token_balance: number;
}

export function useProvision() {
  return useMutation({
    mutationFn: (data: ProvisionRequest) =>
      apiClient<ProvisionResponse>("admin/provision", {
        method: "POST",
        body: data,
      }),
  });
}
```

- [ ] **Step 3: Create user hooks**

Create `gateway-dashboard/src/lib/queries/use-users.ts`:

```typescript
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";

interface User {
  id: string;
  phone: string;
  external_uid: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface UserDetail extends User {
  subscription?: Subscription;
  plan?: Plan;
}

interface Subscription {
  id: string;
  plan_id: string;
  token_balance: number;
  status: string;
  period_start: string;
  period_end: string;
}

interface Plan {
  id: string;
  name: string;
  monthly_tokens: number;
}

interface ApiKey {
  id: string;
  key_prefix: string;
  status: string;
  created_at: string;
  last_used_at: string;
}

interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

interface UserUsage {
  user_id: string;
  days: number;
  daily: { date: string; tokens: number; requests: number }[];
  total_tokens: number;
  total_requests: number;
}

export function useUsers(page: number = 1, search?: string) {
  return useQuery({
    queryKey: ["users", page, search],
    queryFn: () =>
      apiClient<PaginatedResponse<User>>("admin/users", {
        params: { page, page_size: 20, search },
      }),
  });
}

export function useUser(id: string) {
  return useQuery({
    queryKey: ["users", id],
    queryFn: () => apiClient<UserDetail>(`admin/users/${id}`),
    enabled: !!id,
  });
}

export function useUserSubscriptions(userId: string) {
  return useQuery({
    queryKey: ["users", userId, "subscriptions"],
    queryFn: () =>
      apiClient<PaginatedResponse<Subscription>>(`admin/users/${userId}/subscriptions`),
    enabled: !!userId,
  });
}

export function useUserApiKeys(userId: string) {
  return useQuery({
    queryKey: ["users", userId, "api-keys"],
    queryFn: () =>
      apiClient<PaginatedResponse<ApiKey>>(`admin/users/${userId}/api-keys`),
    enabled: !!userId,
  });
}

export function useUserUsage(userId: string, days: number = 7) {
  return useQuery({
    queryKey: ["users", userId, "usage", days],
    queryFn: () =>
      apiClient<UserUsage>(`admin/users/${userId}/usage`, {
        params: { days },
      }),
    enabled: !!userId,
  });
}

export function useUpdateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; status?: string }) =>
      apiClient(`admin/users/${id}`, { method: "PUT", body: data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
  });
}

export function useDeleteUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiClient(`admin/users/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
  });
}

export function useAdjustTokens() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ subscriptionId, delta }: { subscriptionId: string; delta: number }) =>
      apiClient(`admin/subscriptions/${subscriptionId}/tokens`, {
        method: "PUT",
        body: { delta },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
  });
}

export function useCreateApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      apiClient<{ id: string; api_key: string }>(`admin/users/${userId}/api-keys`, {
        method: "POST",
        body: {},
      }),
    onSuccess: (_, userId) => {
      queryClient.invalidateQueries({ queryKey: ["users", userId, "api-keys"] });
    },
  });
}
```

- [ ] **Step 4: Create plan hooks**

Create `gateway-dashboard/src/lib/queries/use-plans.ts`:

```typescript
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";

interface Plan {
  id: string;
  name: string;
  monthly_tokens: number;
  rpm_limit: number;
  rpd_limit: number;
  allowed_models: string[];
  token_multipliers: Record<string, number>;
  created_at: string;
  updated_at: string;
}

interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

interface PlanInput {
  name: string;
  monthly_tokens: number;
  rpm_limit: number;
  rpd_limit: number;
  allowed_models: string[];
  token_multipliers: Record<string, number>;
}

export function usePlans() {
  return useQuery({
    queryKey: ["plans"],
    queryFn: () => apiClient<PaginatedResponse<Plan>>("admin/plans"),
  });
}

export function usePlan(id: string) {
  return useQuery({
    queryKey: ["plans", id],
    queryFn: () => apiClient<Plan>(`admin/plans/${id}`),
    enabled: !!id,
  });
}

export function useCreatePlan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: PlanInput) =>
      apiClient<Plan>("admin/plans", { method: "POST", body: data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["plans"] });
    },
  });
}

export function useUpdatePlan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: PlanInput & { id: string }) =>
      apiClient<Plan>(`admin/plans/${id}`, { method: "PUT", body: data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["plans"] });
    },
  });
}

export function useDeletePlan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiClient(`admin/plans/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["plans"] });
    },
  });
}
```

- [ ] **Step 5: Create provider hooks**

Create `gateway-dashboard/src/lib/queries/use-providers.ts`:

```typescript
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";

interface Provider {
  id: string;
  name: string;
  provider_type: string;
  status: string;
  priority: number;
  total_quota: number;
  used_quota: number;
  created_at: string;
  updated_at: string;
}

interface ProviderUsage {
  used_quota: number;
  total_quota: number;
  request_count: number;
  last_used_at: string;
}

interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

interface ProviderInput {
  name: string;
  provider_type: string;
  api_key?: string;
  total_quota: number;
  priority: number;
  status?: string;
}

export function useProviders() {
  return useQuery({
    queryKey: ["providers"],
    queryFn: () => apiClient<PaginatedResponse<Provider>>("admin/providers"),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function useProvider(id: string) {
  return useQuery({
    queryKey: ["providers", id],
    queryFn: () => apiClient<Provider>(`admin/providers/${id}`),
    enabled: !!id,
  });
}

export function useProviderUsage(id: string) {
  return useQuery({
    queryKey: ["providers", id, "usage"],
    queryFn: () => apiClient<ProviderUsage>(`admin/providers/${id}/usage`),
    enabled: !!id,
  });
}

export function useCreateProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: ProviderInput) =>
      apiClient<Provider>("admin/providers", { method: "POST", body: data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["providers"] });
    },
  });
}

export function useUpdateProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: ProviderInput & { id: string }) =>
      apiClient<Provider>(`admin/providers/${id}`, { method: "PUT", body: data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["providers"] });
    },
  });
}
```

- [ ] **Step 6: Create API key hooks**

Create `gateway-dashboard/src/lib/queries/use-api-keys.ts`:

```typescript
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";

interface ApiKeyItem {
  id: string;
  key_prefix: string;
  user_id: string;
  user_phone: string;
  status: string;
  created_at: string;
  last_used_at: string;
}

interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

export function useApiKeys(page: number = 1, search?: string) {
  return useQuery({
    queryKey: ["api-keys", page, search],
    queryFn: () =>
      apiClient<PaginatedResponse<ApiKeyItem>>("admin/api-keys", {
        params: { page, page_size: 20, search },
      }),
  });
}

export function useRevokeApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiClient(`admin/api-keys/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["api-keys"] });
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
  });
}
```

- [ ] **Step 7: Verify build**

```bash
cd /Users/yanan/work/mono/gateway-dashboard && npm run build
```

Expected: Build succeeds (hooks are tree-shaken since no page imports them yet).

- [ ] **Step 8: Commit**

```bash
cd /Users/yanan/work/mono
git add gateway-dashboard/src/lib/queries/
git commit -m "feat(gateway-dashboard): add React Query hooks for all API endpoints"
```

---

## Task 6: Dashboard Page

**Depends on:** Task 3 (shell), Task 4 (shared components), Task 5 (hooks)
**Files:**
- Create: `gateway-dashboard/src/components/dashboard/provider-overview.tsx`
- Create: `gateway-dashboard/src/components/dashboard/token-pool.tsx`
- Create: `gateway-dashboard/src/components/dashboard/user-overview.tsx`
- Create: `gateway-dashboard/src/components/dashboard/stats-cards.tsx`
- Create: `gateway-dashboard/src/components/dashboard/token-chart.tsx`
- Create: `gateway-dashboard/src/components/dashboard/model-distribution.tsx`
- Modify: `gateway-dashboard/src/app/dashboard/page.tsx`

- [ ] **Step 1: Create provider overview component**

Create `gateway-dashboard/src/components/dashboard/provider-overview.tsx`:

```tsx
"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { useProviders } from "@/lib/queries/use-providers";
import { formatTokens, statusVariant } from "@/lib/utils";

export function ProviderOverview() {
  const { data, isLoading, error } = useProviders();

  if (isLoading) {
    return (
      <Card>
        <CardHeader><CardTitle>Provider Quota Overview</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader><CardTitle>Provider Quota Overview</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm text-destructive">Failed to load providers</p>
        </CardContent>
      </Card>
    );
  }

  const providers = data?.items ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Provider Quota Overview</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {providers.length === 0 && (
          <p className="text-sm text-muted-foreground">No providers configured</p>
        )}
        {providers.map((p) => {
          const pct = p.total_quota > 0 ? (p.used_quota / p.total_quota) * 100 : 0;
          return (
            <div key={p.id} className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Badge variant={statusVariant(p.status)}>{p.status}</Badge>
                  <span className="font-medium text-sm">{p.name}</span>
                  <span className="text-xs text-muted-foreground">{p.provider_type}</span>
                </div>
                <span className="text-sm text-muted-foreground">
                  Priority: {p.priority}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <Progress value={pct} className="flex-1" />
                <span className="text-sm font-mono w-24 text-right">
                  {formatTokens(p.used_quota)} / {formatTokens(p.total_quota)}
                </span>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Create token pool component**

Create `gateway-dashboard/src/components/dashboard/token-pool.tsx`:

```tsx
"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useTokenPool } from "@/lib/queries/use-stats";
import { formatTokens, formatPercentChange } from "@/lib/utils";
import { ArrowUpRight, ArrowDownRight } from "lucide-react";

export function TokenPool() {
  const { data, isLoading, error } = useTokenPool();

  if (isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-6">
          <p className="text-sm text-destructive">Failed to load token pool</p>
        </CardContent>
      </Card>
    );
  }

  if (!data) return null;

  const metrics = [
    { label: "Total Distributed", value: data.total_distributed },
    {
      label: "Total Consumed",
      value: data.total_consumed,
      change: data.consumed_change_7d_pct,
    },
    { label: "Global Remaining", value: data.global_remaining },
  ];

  return (
    <div className="grid gap-4 md:grid-cols-3">
      {metrics.map((m) => (
        <Card key={m.label}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {m.label}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatTokens(m.value)}</div>
            <p className="text-xs text-muted-foreground">tokens</p>
            {m.change !== undefined && (
              <div className="flex items-center gap-1 mt-1">
                {m.change >= 0 ? (
                  <ArrowUpRight className="h-3 w-3 text-red-500" />
                ) : (
                  <ArrowDownRight className="h-3 w-3 text-green-500" />
                )}
                <span className="text-xs text-muted-foreground">
                  {formatPercentChange(m.change)} vs 7d
                </span>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Create user overview component**

Create `gateway-dashboard/src/components/dashboard/user-overview.tsx`:

```tsx
"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { useUserStats } from "@/lib/queries/use-stats";

export function UserOverview() {
  const { data, isLoading, error } = useUserStats();

  if (isLoading) return <Skeleton className="h-24" />;

  if (error) {
    return (
      <Card>
        <CardContent className="py-4">
          <p className="text-sm text-destructive">Failed to load user stats</p>
        </CardContent>
      </Card>
    );
  }

  if (!data) return null;

  const activeRate = data.total > 0 ? (data.active / data.total) * 100 : 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">User Distribution</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-4 text-sm">
          <span>Total: <strong>{data.total}</strong></span>
          <span className="text-green-500">Active: {data.active}</span>
          <span className="text-muted-foreground">Disabled: {data.disabled}</span>
          <span className="text-yellow-500">Expired: {data.expired}</span>
        </div>
        <div className="flex items-center gap-3">
          <Progress value={activeRate} className="flex-1" />
          <span className="text-sm font-medium">{activeRate.toFixed(0)}% active</span>
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: Create stats cards component**

Create `gateway-dashboard/src/components/dashboard/stats-cards.tsx`:

```tsx
"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useUsageStats } from "@/lib/queries/use-stats";
import { useProviders } from "@/lib/queries/use-providers";
import { useApiKeys } from "@/lib/queries/use-api-keys";
import { formatTokens, formatNumber, formatPercentChange } from "@/lib/utils";
import { Activity, Coins, Plug, KeyRound } from "lucide-react";

export function StatsCards() {
  const usage = useUsageStats();
  const providers = useProviders();
  const apiKeys = useApiKeys();

  const isLoading = usage.isLoading || providers.isLoading || apiKeys.isLoading;

  if (isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
    );
  }

  const activeProviders = providers.data?.items?.filter((p) => p.status === "active").length ?? 0;
  const totalProviders = providers.data?.items?.length ?? 0;

  const cards = [
    {
      label: "Today's Requests",
      value: formatNumber(usage.data?.total_requests ?? 0),
      change: usage.data?.requests_change_pct,
      icon: Activity,
    },
    {
      label: "Today's Token Consumption",
      value: formatTokens(usage.data?.total_tokens ?? 0),
      change: usage.data?.tokens_change_pct,
      icon: Coins,
    },
    {
      label: "Active Providers",
      value: `${activeProviders} / ${totalProviders}`,
      icon: Plug,
    },
    {
      label: "Active API Keys",
      value: formatNumber(apiKeys.data?.total ?? 0),
      icon: KeyRound,
    },
  ];

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <Card key={card.label}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {card.label}
              </CardTitle>
              <Icon className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{card.value}</div>
              {card.change !== undefined && (
                <p className="text-xs text-muted-foreground">
                  {formatPercentChange(card.change)} vs yesterday
                </p>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 5: Create token chart component**

Create `gateway-dashboard/src/components/dashboard/token-chart.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useUsageTrend } from "@/lib/queries/use-stats";
import { formatTokens } from "@/lib/utils";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

export function TokenChart() {
  const [period, setPeriod] = useState<"7d" | "30d">("7d");
  const { data, isLoading, error, refetch } = useUsageTrend(period);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Token Consumption Trend</CardTitle>
        <div className="flex gap-1">
          <Button
            variant={period === "7d" ? "default" : "ghost"}
            size="sm"
            onClick={() => setPeriod("7d")}
          >
            7d
          </Button>
          <Button
            variant={period === "30d" ? "default" : "ghost"}
            size="sm"
            onClick={() => setPeriod("30d")}
          >
            30d
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading && <Skeleton className="h-[300px]" />}
        {error && (
          <div className="flex flex-col items-center justify-center h-[300px] gap-2">
            <p className="text-sm text-destructive">Failed to load chart data</p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Retry
            </Button>
          </div>
        )}
        {data && (
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={data.data}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis
                dataKey="date"
                stroke="hsl(var(--muted-foreground))"
                fontSize={12}
                tickFormatter={(v) => v.slice(5)} // MM-DD
              />
              <YAxis
                stroke="hsl(var(--muted-foreground))"
                fontSize={12}
                tickFormatter={formatTokens}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--card))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "6px",
                }}
                labelStyle={{ color: "hsl(var(--foreground))" }}
                formatter={(value: number) => [formatTokens(value), "Tokens"]}
              />
              <Line
                type="monotone"
                dataKey="total_tokens"
                stroke="hsl(var(--primary))"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 6: Create model distribution component**

Create `gateway-dashboard/src/components/dashboard/model-distribution.tsx`:

```tsx
"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useUsageTrend } from "@/lib/queries/use-stats";
import { formatTokens } from "@/lib/utils";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from "recharts";

const COLORS = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-5))",
];

export function ModelDistribution() {
  const { data, isLoading, error, refetch } = useUsageTrend("7d");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Model Distribution</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && <Skeleton className="h-[300px]" />}
        {error && (
          <div className="flex flex-col items-center justify-center h-[300px] gap-2">
            <p className="text-sm text-destructive">Failed to load chart data</p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Retry
            </Button>
          </div>
        )}
        {data && data.model_distribution.length > 0 && (
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie
                data={data.model_distribution}
                dataKey="tokens"
                nameKey="model"
                cx="50%"
                cy="50%"
                innerRadius={60}
                outerRadius={100}
                paddingAngle={2}
              >
                {data.model_distribution.map((_, i) => (
                  <Cell key={i} fill={COLORS[i % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--card))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "6px",
                }}
                formatter={(value: number) => formatTokens(value)}
              />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        )}
        {data && data.model_distribution.length === 0 && (
          <div className="flex items-center justify-center h-[300px]">
            <p className="text-sm text-muted-foreground">No usage data yet</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 7: Assemble dashboard page**

Replace `gateway-dashboard/src/app/dashboard/page.tsx`:

```tsx
"use client";

import { ProviderOverview } from "@/components/dashboard/provider-overview";
import { TokenPool } from "@/components/dashboard/token-pool";
import { UserOverview } from "@/components/dashboard/user-overview";
import { StatsCards } from "@/components/dashboard/stats-cards";
import { TokenChart } from "@/components/dashboard/token-chart";
import { ModelDistribution } from "@/components/dashboard/model-distribution";

export default function DashboardPage() {
  return (
    <div className="space-y-6">
      {/* Area 1: Account Overview */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Account Overview</h2>
        <TokenPool />
        <div className="grid gap-4 lg:grid-cols-2">
          <ProviderOverview />
          <UserOverview />
        </div>
      </div>

      {/* Area 2: Operational Stats */}
      <StatsCards />

      {/* Area 3: Trend Charts */}
      <div className="grid gap-4 lg:grid-cols-2">
        <TokenChart />
        <ModelDistribution />
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Verify build**

```bash
cd /Users/yanan/work/mono/gateway-dashboard && npm run build
```

Expected: Build succeeds.

- [ ] **Step 9: Commit**

```bash
cd /Users/yanan/work/mono
git add gateway-dashboard/src/components/dashboard/ gateway-dashboard/src/app/dashboard/
git commit -m "feat(gateway-dashboard): implement dashboard page with account overview, stats, and charts"
```

---

## Task 7: Provision Page

**Depends on:** Task 4 (shared), Task 5 (hooks)
**Files:**
- Create: `gateway-dashboard/src/components/provision/provision-form.tsx`
- Create: `gateway-dashboard/src/app/provision/page.tsx`

- [ ] **Step 1: Create provision form component**

Create `gateway-dashboard/src/components/provision/provision-form.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Copy, Check, AlertTriangle } from "lucide-react";
import { usePlans } from "@/lib/queries/use-plans";
import { useProvision } from "@/lib/queries/use-provision";
import { formatTokens } from "@/lib/utils";

const schema = z.object({
  phone: z.string().min(1, "Phone number is required"),
  external_uid: z.string().optional(),
  plan_name: z.string().min(1, "Please select a plan"),
});

type FormValues = z.infer<typeof schema>;

export function ProvisionForm() {
  const [result, setResult] = useState<{
    user_id: string;
    api_key: string;
    plan_name: string;
    token_balance: number;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  const plans = usePlans();
  const provision = useProvision();

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { phone: "", external_uid: "", plan_name: "" },
  });

  async function onSubmit(values: FormValues) {
    try {
      const data = await provision.mutateAsync(values);
      setResult(data);
      form.reset();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Provision failed");
    }
  }

  function copyKey() {
    if (result) {
      navigator.clipboard.writeText(result.api_key);
      setCopied(true);
      toast.success("API Key copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    }
  }

  if (result) {
    return (
      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle className="text-green-500">Provision Successful</CardTitle>
          <CardDescription>User has been created with an active subscription.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">User ID</span>
              <span className="font-mono">{result.user_id}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Plan</span>
              <span>{result.plan_name}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Token Balance</span>
              <span>{formatTokens(result.token_balance)}</span>
            </div>
          </div>

          <div className="rounded-md border p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">API Key</span>
              <Button variant="ghost" size="sm" onClick={copyKey}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <code className="block text-sm font-mono break-all bg-muted p-2 rounded">
              {result.api_key}
            </code>
            <div className="flex items-center gap-1 text-xs text-yellow-500">
              <AlertTriangle className="h-3 w-3" />
              <span>This key is shown only once. Copy it now.</span>
            </div>
          </div>

          <Button
            variant="outline"
            className="w-full"
            onClick={() => setResult(null)}
          >
            Provision Another
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="max-w-lg">
      <CardHeader>
        <CardTitle>One-Click Provision</CardTitle>
        <CardDescription>
          Create a new user with a subscription and API key in one step.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="phone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Phone Number</FormLabel>
                  <FormControl>
                    <Input placeholder="138xxxx1234" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="external_uid"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>External UID (optional)</FormLabel>
                  <FormControl>
                    <Input placeholder="user-12345" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="plan_name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Plan</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a plan" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {plans.data?.items?.map((plan) => (
                        <SelectItem key={plan.id} value={plan.name}>
                          {plan.name} — {formatTokens(plan.monthly_tokens)} tokens/mo
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <Button type="submit" className="w-full" disabled={provision.isPending}>
              {provision.isPending ? "Provisioning..." : "Provision User"}
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Create provision page**

Create `gateway-dashboard/src/app/provision/page.tsx`:

```tsx
import { ProvisionForm } from "@/components/provision/provision-form";
import { PageHeader } from "@/components/shared/page-header";

export default function ProvisionPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Provision"
        description="One-click user onboarding with subscription and API key."
      />
      <ProvisionForm />
    </div>
  );
}
```

- [ ] **Step 3: Verify build**

```bash
cd /Users/yanan/work/mono/gateway-dashboard && npm run build
```

Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
cd /Users/yanan/work/mono
git add gateway-dashboard/src/components/provision/ gateway-dashboard/src/app/provision/
git commit -m "feat(gateway-dashboard): add one-click provision page with form and result card"
```

---

## Task 8: User Management Pages

**Depends on:** Task 4 (shared), Task 5 (hooks)
**Files:**
- Create: `gateway-dashboard/src/app/users/page.tsx`
- Create: `gateway-dashboard/src/app/users/[id]/page.tsx`

- [ ] **Step 1: Create users list page**

Create `gateway-dashboard/src/app/users/page.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ColumnDef } from "@tanstack/react-table";
import { useQueryState, parseAsInteger } from "nuqs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MoreHorizontal, Eye, Ban, Trash2, UserCheck } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shared/page-header";
import { DataTable } from "@/components/shared/data-table";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { useUsers, useUpdateUser, useDeleteUser } from "@/lib/queries/use-users";
import { formatDate, formatTokens, statusVariant } from "@/lib/utils";

interface User {
  id: string;
  phone: string;
  external_uid: string;
  status: string;
  current_plan?: string;
  token_balance?: number;
  created_at: string;
}

export default function UsersPage() {
  const router = useRouter();
  const [page, setPage] = useQueryState("page", parseAsInteger.withDefault(1));
  const [search, setSearch] = useQueryState("search", { defaultValue: "" });
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null);

  const { data, isLoading } = useUsers(page, search || undefined);
  const updateUser = useUpdateUser();
  const deleteUser = useDeleteUser();

  async function handleToggleStatus(user: User) {
    const newStatus = user.status === "active" ? "disabled" : "active";
    try {
      await updateUser.mutateAsync({ id: user.id, status: newStatus });
      toast.success(`User ${newStatus === "active" ? "enabled" : "disabled"}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update user");
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      await deleteUser.mutateAsync(deleteTarget.id);
      toast.success("User deleted");
      setDeleteTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete user");
    }
  }

  const columns: ColumnDef<User>[] = [
    { accessorKey: "phone", header: "Phone" },
    { accessorKey: "external_uid", header: "External UID" },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => (
        <Badge variant={statusVariant(row.original.status)}>
          {row.original.status}
        </Badge>
      ),
    },
    { accessorKey: "current_plan", header: "Plan" },
    {
      accessorKey: "token_balance",
      header: "Token Balance",
      cell: ({ row }) =>
        row.original.token_balance !== undefined
          ? formatTokens(row.original.token_balance)
          : "—",
    },
    {
      accessorKey: "created_at",
      header: "Created",
      cell: ({ row }) => formatDate(row.original.created_at),
    },
    {
      id: "actions",
      cell: ({ row }) => {
        const user = row.original;
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => router.push(`/users/${user.id}`)}>
                <Eye className="mr-2 h-4 w-4" /> View Details
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleToggleStatus(user)}>
                {user.status === "active" ? (
                  <><Ban className="mr-2 h-4 w-4" /> Disable</>
                ) : (
                  <><UserCheck className="mr-2 h-4 w-4" /> Enable</>
                )}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive"
                onClick={() => setDeleteTarget(user)}
              >
                <Trash2 className="mr-2 h-4 w-4" /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title="Users" description="Manage gateway users and their subscriptions." />

      <Input
        placeholder="Search by phone or UID..."
        value={search}
        onChange={(e) => { setSearch(e.target.value); setPage(1); }}
        className="max-w-sm"
      />

      <DataTable
        columns={columns}
        data={data?.items ?? []}
        total={data?.total ?? 0}
        page={page}
        pageSize={20}
        onPageChange={setPage}
        isLoading={isLoading}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete User"
        description="This will soft-delete the user. Active subscriptions will be cancelled and API keys will be revoked. Usage logs are preserved."
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={handleDelete}
        loading={deleteUser.isPending}
      />
    </div>
  );
}
```

- [ ] **Step 2: Create user detail page**

Create `gateway-dashboard/src/app/users/[id]/page.tsx`:

```tsx
"use client";

import { useState } from "react";
import { use } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { Copy, Check, Plus, Trash2, AlertTriangle } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import {
  useUser,
  useUserSubscriptions,
  useUserApiKeys,
  useUserUsage,
  useAdjustTokens,
  useCreateApiKey,
} from "@/lib/queries/use-users";
import { useRevokeApiKey } from "@/lib/queries/use-api-keys";
import { formatTokens, formatDate, formatDateTime, formatNumber, statusVariant } from "@/lib/utils";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";

export default function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);
  const [tokenDelta, setTokenDelta] = useState("");
  const [newKeyResult, setNewKeyResult] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const user = useUser(id);
  const subs = useUserSubscriptions(id);
  const keys = useUserApiKeys(id);
  const usage = useUserUsage(id);
  const adjustTokens = useAdjustTokens();
  const createKey = useCreateApiKey();
  const revokeKey = useRevokeApiKey();

  const activeSub = subs.data?.items?.find((s) => s.status === "active");
  const currentBalance = activeSub?.token_balance ?? 0;
  const delta = parseInt(tokenDelta) || 0;
  const newBalance = currentBalance + delta;

  async function handleAdjustTokens() {
    if (!activeSub || delta === 0) return;
    try {
      await adjustTokens.mutateAsync({ subscriptionId: activeSub.id, delta });
      toast.success("Token balance adjusted");
      setTokenDialogOpen(false);
      setTokenDelta("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to adjust tokens");
    }
  }

  async function handleCreateKey() {
    try {
      const result = await createKey.mutateAsync(id);
      setNewKeyResult(result.api_key);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create API key");
    }
  }

  async function handleRevokeKey() {
    if (!revokeTarget) return;
    try {
      await revokeKey.mutateAsync(revokeTarget);
      toast.success("API key revoked");
      setRevokeTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to revoke key");
    }
  }

  function copyKey() {
    if (newKeyResult) {
      navigator.clipboard.writeText(newKeyResult);
      setCopied(true);
      toast.success("Copied");
      setTimeout(() => setCopied(false), 2000);
    }
  }

  if (user.isLoading) {
    return <div className="space-y-4">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-32" />)}</div>;
  }

  if (!user.data) {
    return <p className="text-muted-foreground">User not found</p>;
  }

  const u = user.data;

  return (
    <div className="space-y-6">
      <PageHeader title={u.phone} description={`UID: ${u.external_uid || "—"}`} />

      {/* User Info */}
      <Card>
        <CardHeader><CardTitle>User Info</CardTitle></CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 text-sm">
          <div><span className="text-muted-foreground">Status:</span> <Badge variant={statusVariant(u.status)}>{u.status}</Badge></div>
          <div><span className="text-muted-foreground">Created:</span> {formatDateTime(u.created_at)}</div>
        </CardContent>
      </Card>

      {/* Subscription */}
      {activeSub && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Active Subscription</CardTitle>
            <Button variant="outline" size="sm" onClick={() => setTokenDialogOpen(true)}>
              Adjust Tokens
            </Button>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-4 text-sm">
            <div><span className="text-muted-foreground">Plan:</span> <strong>{u.plan?.name ?? "—"}</strong></div>
            <div><span className="text-muted-foreground">Token Balance:</span> <strong>{formatTokens(activeSub.token_balance)}</strong></div>
            <div><span className="text-muted-foreground">Period End:</span> {formatDate(activeSub.period_end)}</div>
            <div><span className="text-muted-foreground">Status:</span> <Badge variant={statusVariant(activeSub.status)}>{activeSub.status}</Badge></div>
          </CardContent>
        </Card>
      )}

      {/* API Keys */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>API Keys</CardTitle>
          <Button size="sm" onClick={handleCreateKey} disabled={createKey.isPending}>
            <Plus className="mr-1 h-4 w-4" /> Create Key
          </Button>
        </CardHeader>
        <CardContent>
          {keys.isLoading && <Skeleton className="h-20" />}
          {keys.data?.items?.length === 0 && (
            <p className="text-sm text-muted-foreground">No API keys</p>
          )}
          <div className="space-y-2">
            {keys.data?.items?.map((k) => (
              <div key={k.id} className="flex items-center justify-between rounded-md border p-3">
                <div className="text-sm">
                  <code className="font-mono">{k.key_prefix}...</code>
                  <span className="ml-2 text-muted-foreground">{formatDateTime(k.created_at)}</span>
                  {k.last_used_at && (
                    <span className="ml-2 text-muted-foreground">Last used: {formatDateTime(k.last_used_at)}</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={statusVariant(k.status)}>{k.status}</Badge>
                  {k.status === "active" && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setRevokeTarget(k.id)}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Usage Chart */}
      {usage.data && usage.data.daily.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Usage (Last 7 Days)</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={usage.data.daily}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="date" stroke="hsl(var(--muted-foreground))" fontSize={12} tickFormatter={(v) => v.slice(5)} />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickFormatter={formatTokens} />
                <Tooltip contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "6px" }} />
                <Line type="monotone" dataKey="tokens" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Token Adjustment Dialog */}
      <Dialog open={tokenDialogOpen} onOpenChange={setTokenDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Adjust Token Balance</DialogTitle>
            <DialogDescription>
              Enter a positive number to add tokens, or negative to subtract.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <Input
              type="number"
              placeholder="+50000 or -10000"
              value={tokenDelta}
              onChange={(e) => setTokenDelta(e.target.value)}
            />
            {delta !== 0 && (
              <p className="text-sm">
                Balance: {formatNumber(currentBalance)} → <strong>{formatNumber(newBalance)}</strong>
                {" "}({delta > 0 ? "+" : ""}{formatNumber(delta)})
              </p>
            )}
            {newBalance < 0 && (
              <p className="text-sm text-destructive">Resulting balance cannot be negative</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTokenDialogOpen(false)}>Cancel</Button>
            <Button
              onClick={handleAdjustTokens}
              disabled={delta === 0 || newBalance < 0 || adjustTokens.isPending}
            >
              {adjustTokens.isPending ? "Adjusting..." : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New Key Result Dialog */}
      <Dialog open={!!newKeyResult} onOpenChange={(open) => !open && setNewKeyResult(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>API Key Created</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-md border p-3">
              <code className="text-sm font-mono break-all">{newKeyResult}</code>
              <Button variant="ghost" size="icon" onClick={copyKey}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <div className="flex items-center gap-1 text-xs text-yellow-500">
              <AlertTriangle className="h-3 w-3" />
              <span>This key is shown only once. Copy it now.</span>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Revoke Key Confirm */}
      <ConfirmDialog
        open={!!revokeTarget}
        onOpenChange={(open) => !open && setRevokeTarget(null)}
        title="Revoke API Key"
        description="This will permanently deactivate this API key. Any applications using it will stop working."
        confirmLabel="Revoke"
        variant="destructive"
        onConfirm={handleRevokeKey}
        loading={revokeKey.isPending}
      />
    </div>
  );
}
```

- [ ] **Step 3: Verify build**

```bash
cd /Users/yanan/work/mono/gateway-dashboard && npm run build
```

Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
cd /Users/yanan/work/mono
git add gateway-dashboard/src/app/users/
git commit -m "feat(gateway-dashboard): add user management pages with detail view, token adjustment, and key management"
```

---

## Task 9: Plan Management Page

**Depends on:** Task 4 (shared), Task 5 (hooks)
**Files:**
- Create: `gateway-dashboard/src/app/plans/page.tsx`

- [ ] **Step 1: Create plans page**

Create `gateway-dashboard/src/app/plans/page.tsx` with:
- DataTable showing all plans (name, monthly tokens, RPM/RPD, allowed models as badges, token multipliers)
- "Create Plan" button opening a Dialog with form (react-hook-form + zod)
- Edit action opening same Dialog pre-filled
- Delete action with safety check: call `usePlan(id)` — if active subs exist, show error toast. Otherwise confirm dialog.
- Token multipliers editor: simple key-value pairs rendered as `<Input>` rows with add/remove buttons
- Allowed models: comma-separated input that splits into array

The page should follow the same patterns as users page (ColumnDef, DropdownMenu actions, toast feedback).

- [ ] **Step 2: Verify build**

```bash
cd /Users/yanan/work/mono/gateway-dashboard && npm run build
```

Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
cd /Users/yanan/work/mono
git add gateway-dashboard/src/app/plans/
git commit -m "feat(gateway-dashboard): add plan management page with CRUD and delete safety check"
```

---

## Task 10: Provider Management Page

**Depends on:** Task 4 (shared), Task 5 (hooks)
**Files:**
- Create: `gateway-dashboard/src/app/providers/page.tsx`

- [ ] **Step 1: Create providers page**

Create `gateway-dashboard/src/app/providers/page.tsx` with:
- DataTable showing providers (name, type, status badge, priority, quota progress bar, actions)
- "Add Provider" button opening Dialog with form (name, type dropdown, API key password input, total quota, priority)
- Edit action — same dialog, API key field shows placeholder "Enter new key to update" (never echoes existing)
- Disable/Enable toggle via `useUpdateProvider` with `{ status: "disabled" | "active" }`
- "View Usage" action opening a Dialog that calls `useProviderUsage(id)` and shows used/total quota, request count, last used
- Progress bar coloring: <80% green, 80-95% yellow, >95% red (use `quotaProgressColor` from utils)

Follow same patterns as users and plans pages.

- [ ] **Step 2: Verify build**

```bash
cd /Users/yanan/work/mono/gateway-dashboard && npm run build
```

Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
cd /Users/yanan/work/mono
git add gateway-dashboard/src/app/providers/
git commit -m "feat(gateway-dashboard): add provider management page with quota tracking and usage dialog"
```

---

## Task 11: API Key Management Page

**Depends on:** Task 4 (shared), Task 5 (hooks)
**Files:**
- Create: `gateway-dashboard/src/app/api-keys/page.tsx`

- [ ] **Step 1: Create API keys page**

Create `gateway-dashboard/src/app/api-keys/page.tsx` with:
- DataTable with columns: key prefix (mono font), owner phone, status badge, created at, last used at, actions
- Search input filtering by key prefix or owner phone (via `useQueryState`)
- Pagination synced to URL via nuqs
- Revoke action with confirm dialog
- No create button — note text: "To create a new key, go to the user's detail page."
- Link owner phone to `/users/[user_id]`

Follow same patterns as other pages.

- [ ] **Step 2: Verify build**

```bash
cd /Users/yanan/work/mono/gateway-dashboard && npm run build
```

Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
cd /Users/yanan/work/mono
git add gateway-dashboard/src/app/api-keys/
git commit -m "feat(gateway-dashboard): add API key management page with search and revoke"
```

---

## Task 12: Dockerfile & Docker Compose Integration

**Depends on:** Task 1 (project exists)
**Files:**
- Create: `gateway-dashboard/Dockerfile`
- Modify: `ai-gateway/deploy/docker-compose.yml`

- [ ] **Step 1: Create Dockerfile**

Create `gateway-dashboard/Dockerfile`:

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
EXPOSE 3000
ENV HOSTNAME="0.0.0.0"
CMD ["node", "server.js"]
```

- [ ] **Step 2: Add dashboard service to docker-compose**

Add to `ai-gateway/deploy/docker-compose.yml` — append this service after the existing `redis` service and before the `volumes` section:

```yaml
  gateway-dashboard:
    build:
      context: ../../gateway-dashboard
      dockerfile: Dockerfile
    ports: ["3000:3000"]
    environment:
      - GATEWAY_API_URL=http://ai-gateway:8080
      - ADMIN_TOKEN=${ADMIN_TOKEN}
    depends_on:
      - ai-gateway
```

- [ ] **Step 3: Verify Docker build**

```bash
cd /Users/yanan/work/mono/gateway-dashboard && docker build -t gateway-dashboard:test .
```

Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
cd /Users/yanan/work/mono
git add gateway-dashboard/Dockerfile ai-gateway/deploy/docker-compose.yml
git commit -m "feat(gateway-dashboard): add Dockerfile and integrate with docker-compose"
```

---

## Parallelism Map

Tasks that can run concurrently (no dependency conflicts):

```
Phase 0:            Task 1                        (project scaffolding — must exist first)
Phase 1 (parallel): Task 2, Task 3, Task 4        (all depend only on Task 1)
Phase 2:            Task 5                        (depends on Task 2 for api-client)
Phase 3 (parallel): Task 6, Task 7, Task 8,       (all depend on Task 4 + Task 5)
                    Task 9, Task 10, Task 11
Phase 4:            Task 12                       (depends on Task 1, can run anytime after)
```

When using subagent-driven development, Phase 0 runs first, then Phase 1 (3 parallel), then Phase 2, then Phase 3 (6 parallel), then Phase 4.
