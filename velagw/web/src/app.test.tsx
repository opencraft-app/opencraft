import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import {
  BackgroundJobsPage,
  ChannelManagementPage,
  ConsoleShell,
  OperatorOverviewPage,
  PlanManagementPage,
  ResourceAdminPage,
  SetWorkspace,
  ShardManagementPage,
  TenantManagementPage,
  TrafficProbePage,
  channelPlanScopeKey,
  channelPlanResultsForScope,
  consoleRouteForView,
  consoleTenantIDFromPath,
  consoleViewFromPath,
} from "./app"
import { LLMGatewayAPI, type GatewaySet } from "./api"

const readySet: GatewaySet = {
  id: "set-a",
  name: "Set A",
  base_url: "http://localhost:13001",
  status: "active",
  setup: true,
  admin_user_id: 1,
  created_at: "2026-06-21T00:00:00Z",
  updated_at: "2026-06-21T00:00:00Z",
}

const readySetB: GatewaySet = {
  ...readySet,
  id: "set-b",
  name: "Set B",
  base_url: "http://localhost:13002",
}

describe("SetWorkspace", () => {
  it("uses an in-console enlarge action instead of opening the native console", () => {
    const html = renderToStaticMarkup(<SetWorkspace set={readySet} />)

    expect(html).toContain('aria-label="放大控制台"')
    expect(html).not.toContain("Open native console")
    expect(html).not.toContain('target="_blank"')
  })
})

describe("OperatorOverviewPage", () => {
  it("renders a duty dashboard for operators", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(["operator-overview"], {
      generated_at: "2026-07-07T10:00:00Z",
      totals: { sets: 2, active_sets: 1, users: 10, channel_drifts: 1 },
      sets: [
        { id: "set-a", name: "Set A", status: "active", setup: true, user_count: 8, ready: true },
        { id: "set-b", name: "Set B", status: "disabled", setup: false, user_count: 2, ready: false, last_error: "bootstrap failed" },
      ],
      channel_bundles: [{ bundle_id: "golden", name: "生产模型渠道模板", drift_sets: 1, synced_sets: 1, error_sets: 0 }],
      alerts: [{ kind: "channel_drift", severity: "warning", message: "渠道存在漂移" }],
    })
    const api = new LLMGatewayAPI((async () =>
      new Response(JSON.stringify({ success: true, data: [] }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch)
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <OperatorOverviewPage api={api} />
      </QueryClientProvider>,
    )

    expect(html).toContain("需要处理")
    expect(html).toContain("容量水位")
    expect(html).not.toContain("Set A")
    expect(html).toContain("Set B")
    expect(html).toContain("生产模型渠道模板")
    expect(html).toContain("渠道存在漂移")
    expect(html).toContain("服务集群")
    expect(html).toContain("待处理")
    expect(html).toContain('href="/admin/model-configs"')
    expect(html).toContain('data-slot="alert"')
    expect(html).toContain("其余 1 个服务集群运行正常")
    expect(html).not.toContain("后台任务")
    expect(html).not.toContain("BYOK 同步队列")
    expect(html).not.toContain("租户观测队列")
    expect(html).not.toContain("任务异常")
  })
})

describe("BackgroundJobsPage", () => {
  it("separates scheduled jobs, sync queues, and cleanup work into tabs", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(["background-jobs"], {
      generated_at: "2026-07-07T10:00:00Z",
      byok_sync: { pending: 8, running: 2, error: 1, succeeded: 20, total_open: 11, oldest_pending_age_seconds: 125 },
      observations: { pending: 14, due: 3, running: 2, error: 1, blocked: 4, expired_running_leases: 0, oldest_due_age_seconds: 185 },
      jobs: [
        { name: "check_channel_drift", enabled: true, status: "error", last_error: "remote drift", failure_count: 2, lease_owner: "worker-a" },
        { name: "refresh_set_capacity", enabled: true, status: "success", failure_count: 19, lease_until: "0001-01-01T00:00:00Z" },
      ],
    })
    queryClient.setQueryData(["tenant-deletions"], [
      { id: "tenant-delete-1", status: "running", selector_type: "user_ids", target_count: 2, success_count: 1, failure_count: 0 },
    ])
    queryClient.setQueryData(["set-decommissions"], [
      { id: "set-delete-1", set_id: "set-a", status: "pending", version: 1 },
      { id: "set-delete-complete", set_id: "set-complete", status: "succeeded", version: 1 },
    ])
    const api = new LLMGatewayAPI((async () =>
      new Response(JSON.stringify({ success: true, data: [] }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch)
    const scheduledHTML = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <BackgroundJobsPage api={api} />
      </QueryClientProvider>,
    )

    expect(scheduledHTML).toContain("自动任务")
    expect(scheduledHTML).toContain('data-slot="tabs-list"')
    expect(scheduledHTML).toContain("调度任务")
    expect(scheduledHTML).toContain("同步队列")
    expect(scheduledHTML).toContain("清理任务")
    expect(scheduledHTML).toContain("渠道差异检查")
    expect(scheduledHTML).toContain("remote drift")
    expect(scheduledHTML).toContain("重试")
    expect(scheduledHTML).not.toContain("worker-a")
    expect(scheduledHTML).not.toContain("refresh_set_capacity")
    expect(scheduledHTML).not.toContain("1/1/1")
    expect(scheduledHTML).not.toContain("BYOK 同步队列")
    expect(scheduledHTML).not.toContain("用户删除任务")
    expect(scheduledHTML).toContain('data-slot="table"')

    const queuesHTML = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <BackgroundJobsPage api={api} initialTab="queues" />
      </QueryClientProvider>,
    )
    expect(queuesHTML).toContain("BYOK 同步队列")
    expect(queuesHTML).toContain("租户观测队列")
    expect(queuesHTML).not.toContain("渠道差异检查")
    expect(queuesHTML).not.toContain("用户删除任务")

    const cleanupHTML = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <BackgroundJobsPage api={api} initialTab="cleanup" />
      </QueryClientProvider>,
    )
    expect(cleanupHTML).toContain("用户删除任务")
    expect(cleanupHTML).toContain("空集群注销任务")
    expect(cleanupHTML).toContain("tenant-delete-1")
    expect(cleanupHTML).toContain("set-a")
    expect(cleanupHTML).not.toContain("set-complete")
    expect(cleanupHTML).not.toContain("BYOK 同步队列")
    expect(cleanupHTML).not.toContain("渠道差异检查")
  })
})

describe("PlanManagementPage", () => {
  it("renders entitlement templates and per-set delivery state in operator language", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(["plans"], [
      {
        id: "starter-2026-07",
        name: "入门型",
        monthly_tokens: 10000,
        period_value: 1,
        period_unit: "months",
        is_active: true,
        fingerprint: "abc",
      },
    ])
    queryClient.setQueryData(["plan-set-states", "starter-2026-07"], [
      { plan_id: "starter-2026-07", set_id: "set-a", upstream_plan_id: 42, status: "ready" },
      { plan_id: "starter-2026-07", set_id: "set-b", status: "pending" },
    ])
    queryClient.setQueryData(["plan-periods", "starter-2026-07"], [
      { plan_id: "starter-2026-07", period_value: 14, period_unit: "days" },
    ])
    const api = new LLMGatewayAPI((async () =>
      new Response(JSON.stringify({ success: true, data: [] }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch)

    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <PlanManagementPage api={api} sets={[readySet, readySetB]} />
      </QueryClientProvider>,
    )

    expect(html).toContain("权益模板")
    expect(html).toContain("新增模板")
    expect(html).toContain("复制模板")
    expect(html).toContain("入门型")
    expect(html).toContain("10,000")
    expect(html).toContain("周期变体")
    expect(html).toContain("14 天")
    expect(html).not.toContain("starter-2026-07:14:days")
    expect(html).toContain("集群下发")
    expect(html).toContain("1 个集群已就绪")
    expect(html).toContain("待下发")
    expect(html).not.toContain("Set A")
    expect(html).toContain("Set B")
    expect(html).not.toContain("materialization")
    expect(html).not.toContain("套餐映射")
    expect(html).not.toContain("CTL 首次写入")
  })
})

describe("ShardManagementPage", () => {
  it("renders legacy shard responses that omit the set list", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(["shards"], [
      {
        shard: {
          id: "mysql-a",
          name: "北京数据分片 A",
          kind: "mysql",
          endpoint: "mysql-a.internal:3306",
          status: "active",
          max_connections: 2000,
          reserved_connections: 200,
          warn_ratio: 0.7,
          critical_ratio: 0.85,
        },
        allocatable_connections: 1800,
        logical_connections: 0,
        remaining_connections: 1800,
        utilization: 0,
        capacity_status: "healthy",
      },
    ])
    const api = new LLMGatewayAPI((async () =>
      new Response(JSON.stringify({ success: true, data: [] }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch)

    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <ShardManagementPage api={api} />
      </QueryClientProvider>,
    )

    expect(html).toContain("北京数据分片 A")
    expect(html).toContain("暂无服务集群使用这个数据分片")
    expect(html).toContain("高级配置")
    expect(html).not.toContain("数据分片总览")
  })

  it("does not present missing connection observations as healthy zero usage", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(["shards"], [
      {
        shard: {
          id: "mysql-a",
          name: "北京数据分片 A",
          kind: "mysql",
          endpoint: "mysql-a.internal:3306",
          status: "active",
          max_connections: 2000,
          reserved_connections: 200,
          warn_ratio: 0.7,
          critical_ratio: 0.85,
        },
        sets: [{ set_id: "set-a", name: "Set A", status: "active", setup: true, newapi_replicas: 0, sql_max_open_conns: 0, sql_max_idle_conns: 0, logical_connections: 0 }],
        allocatable_connections: 1800,
        logical_connections: 0,
        remaining_connections: 1800,
        utilization: 0,
        capacity_status: "healthy",
      },
    ])
    const api = new LLMGatewayAPI((async () =>
      new Response(JSON.stringify({ success: true, data: [] }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch)

    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <ShardManagementPage api={api} />
      </QueryClientProvider>,
    )

    expect(html).toContain("连接数据待刷新")
    expect(html).not.toContain("0% 已用")
  })
})

describe("console routing", () => {
  it("maps operator URLs to stable views", () => {
    expect(consoleViewFromPath("/admin")).toBe("overview")
    expect(consoleViewFromPath("/admin/tenants/user-1")).toBe("tenants")
    expect(consoleViewFromPath("/admin/model-configs/golden/releases/run-1")).toBe("channels")
    expect(consoleViewFromPath("/admin/infrastructure/shards/mysql-a")).toBe("shards")
		expect(consoleViewFromPath("/admin/infrastructure/versions")).toBe("versions")
    expect(consoleViewFromPath("/admin/diagnostics/data")).toBe("resources")
    expect(consoleRouteForView("jobs")).toBe("/admin/operations/jobs")
    expect(consoleTenantIDFromPath("/admin/tenants/user%2F42")).toBe("user/42")
    expect(consoleTenantIDFromPath("/admin/tenants")).toBe("")
  })
})

describe("SetControlPage", () => {
  it("renders adjustable capacity watermarks for per-set user scale", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(["sets"], [readySet, readySetB])
    const api = new LLMGatewayAPI((async () =>
      new Response(JSON.stringify({ success: true, data: [] }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch)

    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <ConsoleShell api={api} initialView="sets" />
      </QueryClientProvider>,
    )

    expect(html).toContain("容量策略")
    expect(html).toContain("单 Set 用户上限")
    expect(html).toContain("目标使用率")
    expect(html).toContain("最低预留用户位")
    expect(html).toContain("检查并生成扩容意图")
    expect(html).toContain("扩容不会搬迁存量用户")
  })
})

describe("TrafficProbePage", () => {
  it("renders gateway and direct Set inference probe modes", () => {
    const queryClient = new QueryClient()
    const api = new LLMGatewayAPI((async () => new Response("{}")) as typeof fetch)
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <TrafficProbePage api={api} />
      </QueryClientProvider>,
    )

    expect(html).toContain("/v1/chat/completions")
    expect(html).toContain("开始测试")
    expect(html).toContain("auto")
    expect(html).not.toContain("调用入口")
    expect(html).toContain("高级选项")
    expect(html).toContain("统一网关")
    expect(html).toContain("直连 Set")
		expect(html).toContain("复用用户的固定测试密钥")
    expect(html).not.toContain("Traffic endpoint")
    expect(html).not.toContain("Probe key")
  })
})

describe("ChannelManagementPage", () => {
  it("shows a clean empty state before the first production configuration exists", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(["channel-bundles"], [])
    const api = new LLMGatewayAPI((async () =>
      new Response(JSON.stringify({ success: true, data: [] }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch)

    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <ChannelManagementPage api={api} sets={[]} />
      </QueryClientProvider>,
    )

    expect(html).toContain("尚未配置")
    expect(html).not.toContain("其他配置")
    expect(html).not.toContain("重新检查")
  })

  it("keeps manual check results bound to the configuration and target that produced them", () => {
    const run = {
      scope_key: channelPlanScopeKey("golden-channels", "__all__"),
      results: [{ kind: "error" as const, set_id: "set-a", set_name: "Set A", message: "failed" }],
    }

    expect(channelPlanResultsForScope(run, channelPlanScopeKey("golden-channels", "__all__"))).toHaveLength(1)
    expect(channelPlanResultsForScope(run, channelPlanScopeKey("another-bundle", "__all__"))).toEqual([])
    expect(channelPlanResultsForScope(run, channelPlanScopeKey("golden-channels", "set-b"))).toEqual([])
  })

  it("renders persisted delivery results as the default operator flow", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(["channel-bundles"], [
      {
        id: "golden-channels",
        name: "生产模型渠道模板",
        source_set_id: "set-a",
        fingerprint: "bundle-fp",
        spec: {
          version: 1,
          kind: "newapi-channel-bundle",
          channels: [
            {
              id: "minimax",
              name: "MiniMax",
              type: 1,
              key_hash: "abc123",
              base_url: "https://tokenhub.tencentmaas.com",
              models: "minimax-m2.7",
              group: "default",
              status: "enabled",
            },
          ],
        },
      },
      {
        id: "load-test-copy",
        name: "压测配置副本",
        fingerprint: "bundle-fp",
        spec: { version: 1, kind: "newapi-channel-bundle", channels: [] },
      },
    ])
		queryClient.setQueryData(["channel-bundle-delivery-status", "golden-channels"], {
			bundle_id: "golden-channels",
			status: "pending",
			eligible_sets: 2,
			checked_sets: 2,
			coverage_checked_at: "2026-07-17T06:00:00Z",
			stale_after_seconds: 600,
			has_stale_results: false,
			counts: { synced: 1, pending: 1, drift: 0, error: 0, unchecked: 0, stale: 0 },
			sets: [
				{ set_id: "set-a", set_name: "Set A", status: "synced", last_checked_at: "2026-07-17T06:00:00Z" },
				{ set_id: "set-b", set_name: "Set B", status: "pending", last_checked_at: "2026-07-17T06:00:00Z", diff_json: "{}" },
			],
		})
    queryClient.setQueryData(["channel-bundle-revisions", "golden-channels"], [
      { revision_id: "rev-current", bundle_id: "golden-channels", version: 2, fingerprint: "bundle-fp", created_at: "2026-07-17T06:30:00Z" },
      { revision_id: "rev-old", bundle_id: "golden-channels", version: 1, fingerprint: "old-fp", created_at: "2026-07-16T06:30:00Z" },
    ])
    queryClient.setQueryData(["channel-bundle-releases", "golden-channels"], [])
    const api = new LLMGatewayAPI((async () =>
      new Response(JSON.stringify({ success: true, data: [] }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch)
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <ChannelManagementPage api={api} sets={[readySet, readySetB]} />
      </QueryClientProvider>,
    )

    expect(html).toContain("模型配置")
    expect(html).toContain("操作顺序")
    expect(html).toContain("查看结果")
    expect(html).toContain("更新配置")
    expect(html).toContain("检查差异")
    expect(html).toContain("下发更新")
    expect(html).toContain("检查与下发")
    expect(html).toContain("配置内容")
    expect(html).toContain("版本与记录")
    expect(html).toContain('data-slot="tabs"')
    expect(html).toContain("1 个集群需要更新")
    expect(html).toContain("下发更新")
    expect(html).toContain("重新检查")
    expect(html).toContain("最近检查")
    expect(html).toContain("Set B")
    expect(html).toContain("从黄金集群更新")
    expect(html).toContain("下载完整备份")
    expect(html).toContain("从备份恢复")
    expect(html).toContain("高级操作")
    expect(html).toContain("渠道与模型")
    expect(html).not.toContain("恢复为当前版本")
    expect(html).toContain("当前版本")
    expect(html).toContain("恢复历史版本")
    expect((html.match(/恢复历史版本/g) || []).length).toBe(1)
    expect(html).toContain("其他配置")
    expect(html).not.toContain("压测配置副本")
    expect(html).toContain("MiniMax")
    expect(html).toContain("minimax-m2.7")
    expect(html).not.toContain("生产配置发布")
    expect(html).not.toContain("发布与差异")
    expect(html).not.toContain("批量发布")
    expect(html).not.toContain("差异可视化")
    expect(html).not.toContain("配置编号")
    expect(html).not.toContain("密钥指纹")
  })

  it("does not offer check or publish actions when no service cluster is ready", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(["channel-bundles"], [{
      id: "golden-channels",
      name: "生产模型配置",
      fingerprint: "fp-current",
      created_at: "2026-07-17T06:00:00Z",
      updated_at: "2026-07-17T06:00:00Z",
      spec: { version: 1, kind: "newapi-channel-bundle", channels: [] },
    }])
    queryClient.setQueryData(["channel-bundle-delivery-status", "golden-channels"], {
      bundle_id: "golden-channels",
      status: "empty",
      eligible_sets: 0,
      checked_sets: 0,
      coverage_checked_at: null,
      stale_after_seconds: 600,
      has_stale_results: false,
      counts: { synced: 0, pending: 0, drift: 0, error: 0, unchecked: 0, stale: 0 },
      sets: [],
    })
    const api = new LLMGatewayAPI((async () =>
      new Response(JSON.stringify({ success: true, data: [] }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch)
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <ChannelManagementPage api={api} sets={[{ ...readySet, setup: false }]} />
      </QueryClientProvider>,
    )

    const buttons = html.match(/<button[\s\S]*?<\/button>/g) || []
    expect(html).toContain("暂无可下发的服务集群")
    expect(buttons.some((button) => button.includes("重新检查"))).toBe(false)
    expect(buttons.some((button) => button.includes("下发更新"))).toBe(false)
    expect(html).not.toContain("Set A")
  })
})

describe("TenantManagementPage", () => {
  it("renders a full-width tenant list without a persistent detail column", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(["tenants", "", "", "", ""], {
      total: null,
      limit: 50,
      offset: 0,
      next_cursor: "cursor-next",
      has_more: true,
      items: [
        {
          user_id: "tenant-new",
          backend: "new",
          set_id: "set-a",
          status: "active",
          source: "assignment",
          username: "sgw-tenant-new",
          last_plan_id: "plan-old",
          key_count: 2,
          observed_plan_id: "plan-pro",
          observed_credit_available: 8800,
          observed_credit_status: "ok",
          observed_subscription_status: "active",
          observed_at: "2026-07-05T12:00:00Z",
          assignment_status: "explicit",
          created_at: "2026-07-05T00:00:00Z",
          updated_at: "2026-07-05T12:00:00Z",
        },
      ],
    })
    queryClient.setQueryData(["tenant-statistics"], {
      ready: true,
      total: 349000,
      new_total: 340000,
      pending_total: 9000,
      active_total: 348000,
      disabled_total: 1000,
      deleted_total: 0,
      generated_at: "2026-07-05T12:00:00Z",
      stale: false,
    })
    queryClient.setQueryData(["tenant-state", "tenant-new"], {
      user_id: "tenant-new",
      backend: "new",
      set_id: "set-a",
      current_plan_id: "plan-pro",
      token_balance: 8800,
      credit_available: 8800,
      credit_status: "ok",
      has_active_subscription: true,
      source: "new-api",
    })
    const api = new LLMGatewayAPI((async () =>
      new Response(JSON.stringify({ success: true, data: {} }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch)
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <TenantManagementPage api={api} sets={[readySet]} />
      </QueryClientProvider>,
    )

    expect(html).not.toContain("最近刷新")
    expect(html).not.toContain("刷新观测")
    expect(html).not.toContain("查看完整详情")
    expect(html).not.toContain("重新同步 BYOK")
    expect(html).not.toContain("迁移到新平台")
    expect(html).not.toContain("迁移")
    expect(html).not.toContain("服务线路")
    expect(html).not.toContain("Set 承载")
    expect(html).not.toContain("来源")
    expect(html).toContain("下一页")
    expect(html).toContain("349,000")
    expect(html).toContain("统计于")
    expect(html).toContain("每页 50 条")
    expect(html).toContain("plan-pro")
    expect(html).toContain("8,800")
    expect(html).not.toContain("删除用户")
    expect(html).toContain('href="/admin/tenants/tenant-new"')
    expect(html).toContain('aria-label="查看租户 tenant-new"')
    expect(html).toContain('role="link"')
    expect(html).toContain("table-fixed")
    expect(html).toContain("min-w-[960px]")
    expect(html).toContain("<colgroup>")
    expect(html).toContain("权益状态")
    expect(html).not.toContain("xl:grid-cols-[minmax(0,1fr)_430px]")
    expect(html).toContain('data-slot="table"')
    expect(html).not.toContain("projection")
    expect(html).not.toContain("upstream")
    expect(html).not.toContain("租户总览")
    expect(html).not.toContain("集群筛选")
    expect(html).not.toContain("当前页合计")
    expect(html).not.toContain("已刷新权益")
  })

  it("keeps tenant operations on the dedicated detail route", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(["tenants", "tenant-new", "", "", ""], {
      total: null,
      limit: 50,
      offset: 0,
      next_cursor: "",
      has_more: false,
      items: [
        {
          user_id: "tenant-new",
          backend: "new",
          set_id: "set-a",
          status: "active",
          source: "assignment",
          username: "sgw-tenant-new",
          last_plan_id: "plan-old",
          key_count: 2,
          observed_plan_id: "plan-pro",
          observed_credit_available: 8800,
          observed_credit_status: "ok",
          observed_subscription_status: "active",
          observed_at: "2026-07-05T12:00:00Z",
          assignment_status: "explicit",
          created_at: "2026-07-05T00:00:00Z",
          updated_at: "2026-07-05T12:00:00Z",
        },
      ],
    })
    const api = new LLMGatewayAPI((async () =>
      new Response(JSON.stringify({ success: true, data: {} }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch)
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <TenantManagementPage api={api} sets={[readySet]} initialUserID="tenant-new" />
      </QueryClientProvider>,
    )

    expect(html).toContain("最近刷新")
    expect(html).toContain("刷新观测")
    expect(html).toContain("重新同步 BYOK")
    expect(html).toContain("签发密钥")
    expect(html).toContain("删除用户")
    expect(html).toContain("返回租户列表")
  })
})

describe("ResourceAdminPage", () => {
  it("renders the controlled database browser with plain-language copy", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(["resources"], [
      {
        id: "tenants",
        label: "Tenants",
        primary_key: "user_id",
        columns: [
          { key: "user_id", label: "User ID", primary: true },
          { key: "status", label: "Status" },
          { key: "display_name", label: "Display Name", editable: true },
        ],
        actions: [{ id: "disable", label: "Disable" }],
      },
    ])
    queryClient.setQueryData(["resource-rows", "tenants", 50, 0], {
      resource: {
        id: "tenants",
        label: "Tenants",
        primary_key: "user_id",
        columns: [
          { key: "user_id", label: "User ID", primary: true },
          { key: "status", label: "Status" },
          { key: "display_name", label: "Display Name", editable: true },
        ],
        actions: [{ id: "disable", label: "Disable" }],
      },
      rows: [{ id: "tenant-new", values: { user_id: "tenant-new", status: "active", display_name: "Tenant New" } }],
      total: 1,
      limit: 50,
      offset: 0,
    })
    const api = new LLMGatewayAPI((async () =>
      new Response(JSON.stringify({ success: true, data: [] }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch)
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <ResourceAdminPage api={api} />
      </QueryClientProvider>,
    )

    expect(html).toContain("数据维护")
    expect(html).toContain("只开放常用状态表")
    expect(html).not.toContain("可维护对象")
    expect(html).not.toContain("修改方式")
    expect(html).toContain("tenant-new")
    expect(html).toContain("停用")
    expect(html).not.toContain("Resource Admin")
    expect(html).not.toContain("raw SQL")
  })
})

describe("ConsoleShell", () => {
  it("follows the ai-gateway dashboard shell language", () => {
    const queryClient = new QueryClient()
    const api = new LLMGatewayAPI((async () =>
      new Response(JSON.stringify({ success: true, data: [] }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch)
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <ConsoleShell api={api} />
      </QueryClientProvider>,
    )

    expect(html).toContain("w-60")
    expect(html).toContain('aria-label="折叠侧栏"')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain("border-r border-border bg-background")
    expect(html).toContain("总览")
    expect(html).toContain("发布管理")
    expect(html).toContain("基础设施")
    expect(html).toContain("运维")
    expect(html).not.toContain("模型配置 版本与发布")
    expect(html).not.toContain("自动任务 运行与失败重试")
    expect(html).not.toContain("故障排查 高级数据维护")
    expect(html).not.toContain(">Shard<")
    expect(html).toContain('href="/admin/tenants"')
    expect(html).toContain('href="/admin/model-configs"')
    expect(html).toContain('href="/admin/infrastructure/sets"')
    expect(html).toContain('aria-label="breadcrumb"')
    expect(html).toContain('aria-label="打开导航"')
    expect(html).toContain('data-slot="sheet-trigger"')
    expect(html).toContain("运营总览")
    expect(html).toContain("多集群运营台")
    expect(html).toContain('aria-label="退出登录"')
    expect(html).not.toContain("localhost:18080")
    expect(html).not.toContain("密钥")
    expect(html).not.toContain("访问凭证")
    expect(html).not.toContain("运行时")
    expect(html).not.toContain("服务状态")
    expect(html).not.toContain("签发访问密钥")
    expect(html).not.toContain("为用户生成可调用模型的密钥")
    expect(html).not.toContain("查询用户权益")
    expect(html).not.toContain("user-demo")
    expect(html).not.toContain("Set Gateway Console")
    expect(html).not.toContain("Managed sets")
    expect(html).not.toContain("bg-foreground text-background")
  })

  it("can render the dashboard shell with a collapsed sidebar", () => {
    const queryClient = new QueryClient()
    const api = new LLMGatewayAPI((async () =>
      new Response(JSON.stringify({ success: true, data: [] }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch)
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <ConsoleShell api={api} initialSidebarCollapsed />
      </QueryClientProvider>,
    )

    expect(html).toContain("w-16")
    expect(html).toContain('aria-label="展开侧栏"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-label="总览"')
    expect(html).toContain('title="总览 · 值班第一屏"')
    expect(html).not.toContain("多集群运营台")
  })

  it("keeps set lifecycle declarative while retaining operational cleanup", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(["sets"], [readySet])
    const api = new LLMGatewayAPI((async () =>
      new Response(JSON.stringify({ success: true, data: [] }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch)
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <ConsoleShell api={api} initialView="sets" />
      </QueryClientProvider>,
    )

    expect(html).not.toContain("重新纳管")
    expect(html).not.toContain("纳管集群")
    expect(html).not.toContain('aria-label="重新纳管集群 Set A"')
    expect(html).not.toContain("填写已有服务地址")
    expect(html).toContain("销毁集群")
    expect(html).toContain('aria-label="检查并销毁集群 Set A"')
  })

  it("shows destructive Set operations only for the selected Set", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(["sets"], [readySet, readySetB])
    const api = new LLMGatewayAPI((async () =>
      new Response(JSON.stringify({ success: true, data: [] }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch)
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <ConsoleShell api={api} initialView="sets" />
      </QueryClientProvider>,
    )

    expect(html.match(/检查并销毁集群/g)).toHaveLength(1)
    expect(html).toContain('aria-label="检查并销毁集群 Set A"')
    expect(html).not.toContain('aria-label="检查并销毁集群 Set B"')
  })

  it("shows set console deep links from the managed set list", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(["sets"], [readySet])
    const api = new LLMGatewayAPI((async () =>
      new Response(JSON.stringify({ success: true, data: [] }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch)
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <ConsoleShell api={api} initialView="sets" />
      </QueryClientProvider>,
    )

    expect(html).toContain('aria-label="打开 Set A 的 new-api 首页"')
    expect(html).toContain('href="/_llmgateway_console/set-a/dashboard"')
    expect(html).not.toContain('aria-label="打开 Set A 的用户管理"')
    expect(html).not.toContain('href="/_llmgateway_console/set-a/users"')
    expect(html).not.toContain('aria-label="打开 Set A 的渠道管理"')
    expect(html).not.toContain('href="/_llmgateway_console/set-a/channels"')
    expect(html).not.toContain('aria-label="打开 Set A 的系统设置"')
    expect(html).not.toContain('href="/_llmgateway_console/set-a/system-settings"')
  })

  it("does not expose native console links for disabled sets", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(["sets"], [{ ...readySet, id: "cloud-set-a", name: "Cloud Set A", status: "disabled" }])
    const api = new LLMGatewayAPI((async () =>
      new Response(JSON.stringify({ success: true, data: [] }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch)
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <ConsoleShell api={api} initialView="sets" />
      </QueryClientProvider>,
    )

    expect(html).not.toContain("/_llmgateway_console/cloud-set-a/")
    expect(html).toContain("集群控制台不可用")
  })
})
