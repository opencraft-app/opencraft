# Gateway Dashboard — Admin Panel Design Spec

> Frontend admin dashboard for the AI Gateway SaaS, providing account overview, one-click provisioning, and full CRUD management of users, plans, providers, and API keys.

**Backend Spec:** `docs/superpowers/plans/2026-03-17-ai-gateway.md`

---

## 1. Overview

### Purpose

A single-admin dashboard to manage the AI Gateway SaaS platform. The admin (account owner) distributes API access to sub-users, manages provider quotas, billing plans, and monitors overall resource consumption.

### Key Decisions

| Dimension | Choice |
|-----------|--------|
| Tech Stack | React + Next.js 15 (App Router) + shadcn/ui + Tailwind CSS 4 |
| Data Layer | @tanstack/react-query + @tanstack/react-table |
| Auth Model | Single admin, Admin Token via BFF proxy (no login page) |
| Deployment | Independent SPA, Docker standalone, fronts Go backend |
| UI Style | Dark minimal (Vercel-inspired) |
| State Mgmt | No global store — React Query for server state, nuqs for URL state, useState for local UI |

### Architecture

```
Browser :3000  →  Next.js BFF (API Route)  →  Go Backend :8080  →  Portkey/PG/Redis
```

The BFF proxy layer (`src/app/api/[...path]/route.ts`) injects the Admin Token from server-side environment variables. The browser never sees the token.

---

## 2. Functional Modules

### 2.1 Dashboard — Account Overview (`/dashboard`)

The landing page. Three stacked areas: account overview → operational stats → trend charts.

#### Area 1: Account Overview (top)

A prominent card group titled "Account Overview" with three sections:

**① Provider Quota Overview**
- One row per provider: name, type, status badge, priority, progress bar (used/total quota)
- Progress bar color: <80% green, 80–95% yellow, >95% red
- Status badges: `active` green, `exhausted` red, `disabled` gray
- Data source: `GET /api/admin/providers`

**② Token Resource Pool**
Three large metric cards side-by-side:
- **Total Distributed**: sum of all users' initial subscription token allocations
- **Total Consumed**: sum of all usage, with % change vs 7 days ago
- **Global Remaining**: sum of all users' current `token_balance`
- Data source: `GET /api/admin/stats/token-pool` (**new backend endpoint needed**)

**③ User Distribution Overview**
Compact horizontal bar with counts:
- Total users, Active, Disabled, Expired
- Active rate percentage with progress indicator
- Data source: `GET /api/admin/stats/users`

#### Area 2: Operational Stats (middle, 4 columns)

| Today's Requests | Today's Token Consumption | Active Providers | Active API Keys |
|:---:|:---:|:---:|:---:|
| count + % vs yesterday | count + % vs yesterday | n/total | count |

Data source: `GET /api/admin/stats/usage` + `GET /api/admin/providers`

#### Area 3: Trend Charts (bottom, 2 columns)

- **Left**: Token consumption trend — line chart, 7d/30d toggle
- **Right**: Model call distribution — donut chart, by model name
- Auto-refresh: React Query refetchInterval 30s
- Chart library: recharts (via shadcn/ui chart components)
- **Error state**: On fetch failure, show inline error message with retry button inside the chart card. Skeleton loader during initial load.
- Data source: `GET /api/admin/stats/usage/trend?period=7d&granularity=daily` (**new backend endpoint needed**)

### 2.2 One-Click Provisioning (`/provision`)

A single form card for rapid user onboarding.

**Input Fields:**
- Phone number (required)
- External UID (optional)
- Plan selection (dropdown, populated from `GET /api/admin/plans`)

**Submit:** `POST /api/admin/provision`

**Success Result Card:**
- User ID
- API Key with copy-to-clipboard button
- Plan name + token quota
- Warning: "API Key is shown only once"

**Error Handling:** Inline form validation + toast for server errors (unknown plan, duplicate phone, etc.)

### 2.3 User Management (`/users`)

**Table Columns:** Phone, External UID, Status, Current Plan, Token Balance, Created At, Actions

**Features:**
- Search by phone / external UID
- Pagination synced to URL via nuqs
- Actions: View Details, Disable/Enable, Delete (with confirm dialog)

**Disable/Enable:** Sends `PUT /api/admin/users/:id` with `{ "status": "disabled" }` or `{ "status": "active" }`. Button label and icon toggle based on current status.

**Delete:** Confirm dialog with warning: "This will soft-delete the user (status → deleted). Active subscriptions will be cancelled and API keys will be revoked. Usage logs are preserved." Sends `DELETE /api/admin/users/:id`. Backend handles cascade (cancel subscriptions, revoke keys).

**User Detail Page (`/users/[id]`):**
- User info card (phone, UID, status, created at)
- Current subscription card (plan name, token balance, period end) + Token adjustment button
- API Keys table for this user (prefix, status, created at, last used) + Create/Revoke actions
- User usage chart (recent 7 days)
- Data source for usage chart: `GET /api/admin/users/:id/usage?days=7` (**new backend endpoint needed**)

**Token Adjustment Dialog:**
- Opens from "Adjust Tokens" button on subscription card
- Input: delta value with +/- prefix (e.g., `+50000` to add, `-10000` to subtract)
- Validation: resulting balance must be ≥ 0 (show calculated new balance in real-time)
- Confirm button with summary: "Adjust token balance: 100,000 → 150,000 (+50,000)"
- Sends `PUT /api/admin/subscriptions/:id/tokens` with `{ "delta": 50000 }`
- Success: toast + invalidate subscription query

**API Key Creation Flow:**
- "Create API Key" button in the user detail API Keys table
- Single click — no dialog needed (auto-generate, no configurable options)
- Sends `POST /api/admin/users/:id/api-keys` with empty body
- Response: displays the full key in a result card with copy-to-clipboard button
- Warning: "This key is shown only once. Copy it now."
- After dismissal, table refreshes showing only the key prefix

### 2.4 Plan Management (`/plans`)

**Table Columns:** Plan Name, Monthly Tokens, RPM Limit, RPD Limit, Allowed Models (tags), Token Multipliers, Actions

**Features:**
- No search/filter — plan count is expected to be small (<20)

**Create/Edit Dialog:**
- Name, monthly tokens, RPM/RPD limits
- Allowed models: multi-select tag input
- Token multipliers: key-value editor (model name → multiplier number)

**Actions:** Edit, Delete (with confirm)

**Delete Safety:** Before deletion, frontend calls `GET /api/admin/plans/:id` to check if active subscriptions reference this plan. If active subscriptions exist, show error toast: "Cannot delete plan — N active subscriptions are using it." Otherwise proceed with confirm dialog. Backend enforces this check as well (returns 409 Conflict).

### 2.5 Provider Management (`/providers`)

**Table Columns:** Name, Type, Status (badge), Priority, Used Quota / Total Quota (progress bar), Actions

**Features:**
- No search/filter — provider count is expected to be small (<20)

**Create/Edit Dialog:**
- Name, type (dropdown: openai, anthropic, deepseek, etc.)
- API Key (password input, not echoed back from backend)
- Total quota, priority
- Status toggle

**Actions:** Edit, Disable/Enable, View Usage

**Disable/Enable:** Sends `PUT /api/admin/providers/:id` with `{ "status": "disabled" }` or `{ "status": "active" }`. Providers are never hard-deleted — only disabled via status toggle.

**View Usage:** Opens a dialog showing provider usage details from `GET /api/admin/providers/:id/usage` — used quota, total quota, request count, last used timestamp.

### 2.6 API Key Management (`/api-keys`)

**Table Columns:** Key Prefix (`sk-xxxx...`), Owner (user phone/UID), Status, Created At, Last Used At, Actions

**Features:**
- Search by key prefix or owner phone
- Pagination synced to URL via nuqs

**Actions:** Revoke (with confirm dialog)

**Create:** Navigate to user detail page → create key there (keys are always user-scoped)

Data source: `GET /api/admin/api-keys` (**new backend endpoint needed** — global list with user join)

---

## 3. Technical Architecture

### 3.1 Project Structure

```
gateway-dashboard/
├── src/
│   ├── app/                              # Next.js App Router
│   │   ├── layout.tsx                    # Root layout — dark theme + sidebar shell
│   │   ├── page.tsx                      # / → redirect to /dashboard
│   │   ├── dashboard/page.tsx            # Account overview + stats + charts
│   │   ├── provision/page.tsx            # One-click provisioning form
│   │   ├── users/page.tsx                # User list table
│   │   ├── users/[id]/page.tsx           # User detail (sub + keys + usage)
│   │   ├── plans/page.tsx                # Plan management table
│   │   ├── providers/page.tsx            # Provider management table
│   │   ├── api-keys/page.tsx             # API Key list table
│   │   └── api/[...path]/route.ts        # BFF catch-all proxy to Go backend
│   ├── components/
│   │   ├── layout/
│   │   │   ├── sidebar.tsx               # Sidebar navigation
│   │   │   ├── header.tsx                # Top bar (breadcrumbs)
│   │   │   ├── shell.tsx                 # Page shell container
│   │   │   └── error-boundary.tsx        # Auth error full-page state
│   │   ├── dashboard/
│   │   │   ├── stats-cards.tsx           # Operational stat cards (4-col)
│   │   │   ├── token-chart.tsx           # Token consumption trend line chart
│   │   │   ├── model-distribution.tsx    # Model call donut chart
│   │   │   ├── provider-overview.tsx     # Provider quota progress bars
│   │   │   ├── token-pool.tsx            # Token pool summary cards
│   │   │   └── user-overview.tsx         # User distribution bar
│   │   ├── provision/
│   │   │   └── provision-form.tsx        # Provision form + result card
│   │   └── shared/
│   │       ├── data-table.tsx            # Generic data table (tanstack/table)
│   │       ├── confirm-dialog.tsx        # Confirm action dialog
│   │       └── page-header.tsx           # Page title + description
│   ├── lib/
│   │   ├── api-client.ts                # Fetch wrapper for BFF routes + error handling
│   │   ├── queries/
│   │   │   ├── use-users.ts             # User CRUD hooks
│   │   │   ├── use-plans.ts             # Plan CRUD hooks
│   │   │   ├── use-providers.ts         # Provider CRUD hooks
│   │   │   ├── use-api-keys.ts          # API Key hooks
│   │   │   ├── use-stats.ts             # Dashboard stats hooks
│   │   │   └── use-provision.ts         # Provision mutation hook
│   │   └── utils.ts                     # Formatters, constants, helpers
│   └── styles/
│       └── globals.css                  # Tailwind + shadcn dark theme vars
├── public/
├── .env.example
├── next.config.ts                       # Must set output: 'standalone'
├── tailwind.config.ts
├── tsconfig.json
├── package.json
├── Dockerfile
└── README.md
```

~35 files total.

### 3.2 BFF Proxy Layer

`src/app/api/[...path]/route.ts` — single catch-all route handler:

- Supports all HTTP methods (GET, POST, PUT, DELETE)
- Reads `GATEWAY_API_URL` and `ADMIN_TOKEN` from `process.env`
- **Startup validation**: If `ADMIN_TOKEN` is empty or unset, log a prominent error and return 500 for all requests with message: "ADMIN_TOKEN not configured"
- Forwards: URL path + query params + request body
- Injects: `Authorization: Bearer ${ADMIN_TOKEN}` header
- Returns: upstream response status + JSON body transparently

**Error Handling:**
- **Backend unreachable** (ECONNREFUSED, timeout): Return 502 with `{ "error": "Gateway backend is unreachable" }`
- **Backend returns 401/403**: Return the error to the frontend. The `api-client.ts` detects 401/403 and triggers a full-page error state: "Configuration Error — Admin Token is invalid or expired. Check the ADMIN_TOKEN environment variable and restart the dashboard."
- **Backend returns other errors**: Transparently forward status + body

Benefits:
- Admin Token never reaches the browser
- No CORS configuration needed
- Single point for request/response intercepting (error normalization, logging)

### 3.3 Core Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| next | 15.x | App Router + API Routes + standalone output |
| react / react-dom | 19.x | UI framework |
| tailwindcss | 4.x | Utility-first CSS |
| shadcn/ui | latest | Component library (Table, Form, Dialog, Card, Chart, Badge, etc.) |
| @tanstack/react-query | 5.x | Server state management + caching |
| @tanstack/react-table | 8.x | Headless table logic |
| recharts | 2.x | Charts (used by shadcn/ui chart) |
| nuqs | 2.x | URL query params ↔ React state sync |
| react-hook-form | 7.x | Form state management |
| zod | 3.x | Schema validation (forms + API responses) |
| lucide-react | latest | Icons |
| sonner | latest | Toast notifications |

**Required Next.js config** (`next.config.ts`):
```typescript
const nextConfig = {
  output: 'standalone',
}
```

### 3.4 React Query Strategy

| Data Type | staleTime | refetchInterval | Invalidation |
|-----------|-----------|-----------------|--------------|
| Dashboard stats | 10s | 30s | — (auto-refresh) |
| Provider list | 30s | 60s | On provider mutation |
| Token pool | 10s | 30s | — (auto-refresh) |
| User / Plan / Key lists | 5min | — | On relevant mutation |
| Provision result | ∞ | — | Not cached |

### 3.5 State Management

No global state store (no Redux, Zustand, etc.):
- **Server data**: React Query (cache, refetch, optimistic updates)
- **URL state**: nuqs (table pagination, search filters, date range)
- **Local UI state**: useState (dialog open/close, form dirty state)
- **Form state**: react-hook-form + zod validation

---

## 4. API Contract

### 4.1 Existing Backend Endpoints Used

All paginated list endpoints return a standard envelope: `{ "items": T[], "total": number, "page": number, "page_size": number }`. Query params: `?page=1&page_size=20`.

| Endpoint | Method | Used By |
|----------|--------|---------|
| `/api/admin/stats/usage` | GET | Dashboard operational stats |
| `/api/admin/stats/users` | GET | Dashboard user overview |
| `/api/admin/provision` | POST | Provision form |
| `/api/admin/users` | GET | User list (paginated) |
| `/api/admin/users/:id` | GET | User detail |
| `/api/admin/users/:id` | PUT | User update (including status disable/enable) |
| `/api/admin/users/:id` | DELETE | User soft-delete (cascades: cancel subs, revoke keys) |
| `/api/admin/users/:id/subscriptions` | GET/POST | User subscriptions |
| `/api/admin/subscriptions/:id/tokens` | PUT | Token adjustment (`{ "delta": number }`) |
| `/api/admin/users/:id/api-keys` | GET/POST | User's API keys (POST returns full plaintext key once) |
| `/api/admin/plans` | GET/POST | Plan list, create |
| `/api/admin/plans/:id` | GET | Single plan detail (used for delete pre-check) |
| `/api/admin/plans/:id` | PUT | Plan update |
| `/api/admin/plans/:id` | DELETE | Plan delete (returns 409 if active subscriptions exist) |
| `/api/admin/providers` | GET/POST | Provider list, create |
| `/api/admin/providers/:id` | GET | Single provider detail (for edit dialog pre-fill) |
| `/api/admin/providers/:id` | PUT | Provider update (including status disable/enable) |
| `/api/admin/providers/:id/usage` | GET | Provider usage details |
| `/api/admin/api-keys/:id` | DELETE | Revoke key |

### 4.2 New Backend Endpoints Required

**① `GET /api/admin/stats/token-pool`**

Returns aggregated token resource pool for the account owner.

```json
{
  "total_distributed": 12500000,
  "total_consumed": 8200000,
  "global_remaining": 4300000,
  "consumed_change_7d_pct": 12.5
}
```

- `total_distributed`: SUM of all subscriptions' initial `token_balance` at creation
- `total_consumed`: SUM of all `usage_logs` token amounts
- `global_remaining`: SUM of all active subscriptions' current `token_balance`
- `consumed_change_7d_pct`: percentage change vs previous 7-day period

**② `GET /api/admin/api-keys`**

Returns paginated global API key list with user info joined.

```json
{
  "items": [
    {
      "id": "uuid",
      "key_prefix": "sk-a1b2",
      "user_id": "uuid",
      "user_phone": "138xxxx1234",
      "status": "active",
      "created_at": "2026-03-17T10:00:00Z",
      "last_used_at": "2026-03-17T15:30:00Z"
    }
  ],
  "total": 38,
  "page": 1,
  "page_size": 20
}
```

Query params: `?page=1&page_size=20&status=active&search=sk-a1b2`

**③ `GET /api/admin/stats/usage/trend`**

Returns time-series data for dashboard trend charts.

```json
{
  "period": "7d",
  "granularity": "daily",
  "data": [
    { "date": "2026-03-11", "total_tokens": 120000, "total_requests": 450 },
    { "date": "2026-03-12", "total_tokens": 135000, "total_requests": 512 }
  ],
  "model_distribution": [
    { "model": "gpt-4", "tokens": 450000, "requests": 1200 },
    { "model": "claude-3.5-sonnet", "tokens": 320000, "requests": 800 }
  ]
}
```

Query params: `?period=7d|30d&granularity=daily`

**④ `GET /api/admin/users/:id/usage`**

Returns usage stats for a specific user (admin-scoped).

```json
{
  "user_id": "uuid",
  "days": 7,
  "daily": [
    { "date": "2026-03-11", "tokens": 12000, "requests": 45 }
  ],
  "total_tokens": 85000,
  "total_requests": 320
}
```

Query params: `?days=7`

---

## 5. Deployment

### 5.1 Dockerfile

Multi-stage build using Next.js standalone output:

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
CMD ["node", "server.js"]
```

Image size: ~100MB. No dev dependencies in production.

Requires `output: 'standalone'` in `next.config.ts` (see Section 3.3).

### 5.2 Docker Compose Integration

Add to `ai-gateway/deploy/docker-compose.yml`:

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

### 5.3 Environment Variables

| Variable | Description | Required | Example |
|----------|-------------|----------|---------|
| `GATEWAY_API_URL` | Go backend URL | Yes | `http://ai-gateway:8080` (Docker) / `http://localhost:8080` (dev) |
| `ADMIN_TOKEN` | Admin credential injected by BFF | Yes | `admin-xxxxx` |

If `ADMIN_TOKEN` is missing at runtime, the BFF returns 500 with "ADMIN_TOKEN not configured" for all proxied requests.

### 5.4 Development Setup

```bash
cd gateway-dashboard
cp .env.example .env
npm install
npm run dev    # localhost:3000, hot reload
```

Requires Go backend running on `:8080` (via `cd ai-gateway && make docker-up` or `make run`).

---

## 6. UI Design Guidelines

### Theme

- **Base**: shadcn/ui dark theme (zinc color palette)
- **Inspiration**: Vercel Dashboard — black/dark gray backgrounds, white text, minimal borders
- **Accent**: Blue for primary actions, green/yellow/red for status indicators
- **Typography**: Inter font family (shadcn default)
- **Spacing**: Consistent 4px grid system via Tailwind

### Component Patterns

- **Tables**: shadcn DataTable with column sorting, search input, pagination footer. On narrow screens: horizontal scroll with sticky first column.
- **Forms**: shadcn Form (react-hook-form + zod) inside Dialog for create/edit
- **Feedback**: sonner toast for mutations (success/error), inline form errors for validation
- **Loading**: Skeleton loaders for tables and cards during initial fetch
- **Error States**: Inline error message + retry button for failed data fetches. Full-page error boundary for auth failures (see Section 3.2).
- **Empty States**: Illustrated empty state with call-to-action button (e.g., "No users yet — Provision your first user")
- **Accessibility**: Rely on shadcn/ui built-in a11y (Radix primitives provide ARIA labels, keyboard navigation, focus management). No additional a11y customization required for this admin-only tool.

### Responsive Design

| Breakpoint | Layout |
|------------|--------|
| `≥1024px` (lg) | Full sidebar + multi-column dashboard |
| `768–1023px` (md) | Collapsed sidebar (icons only, expand on hover). Stats cards: 2x2 grid. Charts: stacked vertical. |
| `<768px` (sm) | Sidebar hidden, hamburger menu. Stats cards: single column. Tables: horizontal scroll with sticky first column. |

Primary target is desktop (lg). Tablet (md) is supported. Mobile (sm) is functional but not optimized — acceptable for single-admin use.

### Sidebar Navigation

```
┌─────────────────────┐
│  ⚡ AI Gateway       │
│                     │
│  📊 Dashboard       │
│  🚀 Provision       │
│  ─────────────────  │
│  👥 Users           │
│  📦 Plans           │
│  🔌 Providers       │
│  🔑 API Keys        │
└─────────────────────┘
```

Collapsible on tablet/mobile. Active page highlighted. Section divider between overview and management pages.
