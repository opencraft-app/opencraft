import { afterEach, describe, expect, it, vi } from "vitest"

import { LLMGatewayAPI } from "./api"

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json" },
  })
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("LLMGatewayAPI", () => {
  it("uses the configured cluster admin token by default", async () => {
    vi.stubEnv("VITE_CLUSTER_ADMIN_TOKEN", "test-cluster-token")
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: [] }))

    const api = new LLMGatewayAPI(fetcher)
    await api.listResources()

    expect(fetcher).toHaveBeenCalledWith(
      "/api/admin/resources",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer test-cluster-token" }),
      }),
    )
  })

  it("logs in and unwraps the admin token", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({ success: true, data: { token: "cluster-token" } }),
    )

    const api = new LLMGatewayAPI(fetcher)

    await expect(
      api.login({ username: "cluster-admin", password: "test-local-password" }),
    ).resolves.toEqual({ token: "cluster-token" })
    expect(fetcher).toHaveBeenCalledWith(
      "/api/admin/login",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          username: "cluster-admin",
          password: "test-local-password",
        }),
      }),
    )
  })

  it("logs out through the cookie-clearing endpoint", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ success: true }))
    const api = new LLMGatewayAPI(fetcher)

    await expect(api.logout()).resolves.toBeUndefined()
    expect(fetcher).toHaveBeenCalledWith(
      "/api/admin/logout",
      expect.objectContaining({ method: "POST" }),
    )
  })

  it("uses bearer auth for set operations", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, data: [] }))
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { id: "set-a", setup: true, status: "active" },
        }),
      )

    const api = new LLMGatewayAPI(fetcher, () => "cluster-token")

    await api.listSets()
    await api.registerSet({
      id: "set-a",
      name: "Set A",
      base_url: "http://localhost:13001",
      status: "active",
    })
    await expect(api.bootstrapSet("set-a")).resolves.toMatchObject({
      id: "set-a",
      setup: true,
    })

    for (const call of fetcher.mock.calls) {
      expect(call[1]?.headers).toMatchObject({
        Authorization: "Bearer cluster-token",
      })
    }
  })

  it("uses bearer auth for shard operations", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, data: [] }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { shard: { id: "mysql-a" } } }))
      .mockResolvedValueOnce(jsonResponse({ success: true }))

    const api = new LLMGatewayAPI(fetcher, () => "cluster-token")

    await api.listShards()
    await api.getShard("mysql-a")
    await api.upsertShard({
      id: "mysql-a",
      name: "MySQL A",
      kind: "mysql",
      status: "active",
      max_connections: 2000,
      reserved_connections: 200,
    })

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "/api/admin/shards",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer cluster-token" }) }),
    )
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "/api/admin/shards/mysql-a",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer cluster-token" }) }),
    )
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      "/api/admin/shards",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          id: "mysql-a",
          name: "MySQL A",
          kind: "mysql",
          status: "active",
          max_connections: 2000,
          reserved_connections: 200,
        }),
      }),
    )
  })

  it("defines an entitlement plan through the control API", async () => {
    const created = {
      id: "plan-generated",
      name: "入门型 14 天",
      monthly_tokens: 1_000_000,
      period_value: 14,
      period_unit: "days",
      is_active: true,
      fingerprint: "fingerprint",
    }
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: created }, { status: 201 }))
    const api = new LLMGatewayAPI(fetcher, () => "cluster-token")

    await expect(api.createPlan({
      name: "入门型 14 天",
      monthly_tokens: 1_000_000,
      period_value: 14,
      period_unit: "days",
      is_active: true,
    })).resolves.toEqual(created)
    expect(fetcher).toHaveBeenCalledWith(
      "/api/plans",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "入门型 14 天",
          monthly_tokens: 1_000_000,
          period_value: 14,
          period_unit: "days",
          is_active: true,
        }),
      }),
    )
  })

  it("loads a plan's additional periods and their delivery states", async () => {
    const periods = [
      {
        plan_id: "starter-2026-07",
        period_value: 14,
        period_unit: "days",
      },
    ]
    const states = [
      {
        plan_id: "starter-2026-07",
        period_value: 14,
        period_unit: "days",
        set_id: "set-a",
        upstream_plan_id: 7,
        status: "ready",
      },
    ]
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, data: periods }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: states }))
    const api = new LLMGatewayAPI(fetcher, () => "cluster-token")

    await expect(api.listPlanPeriods("starter-2026-07")).resolves.toEqual(periods)
    await expect(api.listPlanPeriodSetStates("starter-2026-07")).resolves.toEqual(states)
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "/api/plans/starter-2026-07/periods",
      expect.objectContaining({ auth: true }),
    )
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "/api/plans/starter-2026-07/periods/sets",
      expect.objectContaining({ auth: true }),
    )
  })

  it("loads user state with bearer auth", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        data: {
          user_id: "usr/demo",
          backend: "new",
          set_id: "set-b",
          current_plan_id: "plan-pro",
          token_balance: 100000,
          credit_available: 100000,
          credit_status: "ok",
          source: "new-api",
        },
      }),
    )
    const api = new LLMGatewayAPI(fetcher, () => "cluster-token")

    await expect(api.getUserState("usr/demo")).resolves.toMatchObject({
      user_id: "usr/demo",
      backend: "new",
      set_id: "set-b",
      current_plan_id: "plan-pro",
      credit_available: 100000,
    })
    expect(fetcher).toHaveBeenCalledWith(
      "/api/admin/users/usr%2Fdemo/state",
      expect.objectContaining({
        auth: true,
        headers: expect.objectContaining({
          Authorization: "Bearer cluster-token",
        }),
      }),
    )
  })

  it("refreshes tenant observation with bearer auth", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        data: {
          user_id: "usr/demo",
          backend: "new",
          set_id: "set-a",
          current_plan_id: "plan-pro",
          credit_available: 8800,
          credit_status: "ok",
          observed_at: "2026-07-05T12:00:00Z",
        },
      }),
    )
    const api = new LLMGatewayAPI(fetcher, () => "cluster-token")

    await expect(api.observeTenant("usr/demo")).resolves.toMatchObject({
      user_id: "usr/demo",
      current_plan_id: "plan-pro",
      credit_available: 8800,
    })
    expect(fetcher).toHaveBeenCalledWith(
      "/api/admin/users/usr%2Fdemo/observe",
      expect.objectContaining({
        method: "POST",
        auth: true,
        headers: expect.objectContaining({
          Authorization: "Bearer cluster-token",
        }),
      }),
    )
  })

  it("lists tenants with filters, cursor, and bearer auth", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        data: {
          total: null,
          limit: 25,
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
              last_plan_id: "plan-pro",
              key_count: 2,
              assignment_status: "explicit",
            },
          ],
        },
      }),
    )
    const api = new LLMGatewayAPI(fetcher, () => "cluster-token")

    await expect(
      api.listTenants({ backend: "new", set_id: "set-a", cursor: "cursor-1", limit: 25, offset: 0, include_total: false }),
    ).resolves.toMatchObject({
      total: null,
      next_cursor: "cursor-next",
      has_more: true,
      items: [{ user_id: "tenant-new", key_count: 2 }],
    })
    expect(fetcher).toHaveBeenCalledWith(
      "/api/admin/tenants?backend=new&set_id=set-a&cursor=cursor-1&limit=25&offset=0&include_total=false",
      expect.objectContaining({
        auth: true,
        headers: expect.objectContaining({
          Authorization: "Bearer cluster-token",
        }),
      }),
    )
  })

  it("manages channel bundles with bearer auth", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: [
            {
              id: "golden",
              name: "Golden channels",
              fingerprint: "bundle-fp",
              spec: {
                version: 1,
                kind: "newapi-channel-bundle",
                channels: [{ id: "minimax", name: "MiniMax", key_hash: "abc123" }],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { id: "golden", fingerprint: "bundle-fp" } }))
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            bundle_id: "golden",
            set_id: "set-a",
            status: "pending",
            steps: [{ kind: "create_channel", resource_id: "minimax", action: "create" }],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { bundle_id: "golden", set_id: "set-a", status: "synced" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            id: "golden",
            source_set_id: "set-a",
            spec: { channels: [{ id: "minimax", key_hash: "abc123" }] },
          },
        }),
      )
    const api = new LLMGatewayAPI(fetcher, () => "cluster-token")

    await expect(api.listChannelBundles()).resolves.toMatchObject([{ id: "golden", fingerprint: "bundle-fp" }])
    await api.saveChannelBundle({
      id: "golden",
      name: "Golden channels",
      spec: {
        channels: [
          {
            id: "minimax",
            name: "MiniMax",
            type: 1,
            key: "sk-provider",
            base_url: "https://tokenhub.tencentmaas.com",
            models: "minimax-m2.7",
            group: "default",
            status: "enabled",
          },
        ],
      },
    })
    await expect(api.planChannelBundle("golden", { set_id: "set-a" })).resolves.toMatchObject({
      status: "pending",
      steps: [{ kind: "create_channel", resource_id: "minimax" }],
    })
    await expect(api.applyChannelBundle("golden", { set_id: "set-a" })).resolves.toMatchObject({
      status: "synced",
      set_id: "set-a",
    })
    await expect(
      api.importChannelBundle({
        source_set_id: "set-a",
        id: "golden",
        name: "Golden channels",
      }),
    ).resolves.toMatchObject({ id: "golden", source_set_id: "set-a" })

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "/api/channel-bundles",
      expect.objectContaining({ auth: true }),
    )
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "/api/channel-bundles",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"key":"sk-provider"'),
      }),
    )
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      "/api/channel-bundles/golden/plan",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ set_id: "set-a" }),
      }),
    )
    expect(fetcher).toHaveBeenNthCalledWith(
      4,
      "/api/channel-bundles/golden/apply",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ set_id: "set-a" }),
      }),
    )
    expect(fetcher).toHaveBeenNthCalledWith(
      5,
      "/api/channel-bundles/import",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          source_set_id: "set-a",
          id: "golden",
          name: "Golden channels",
        }),
      }),
    )
  })

  it("reads persisted channel delivery status without starting a remote check", async () => {
		const fetcher = vi.fn().mockResolvedValue(jsonResponse({
			success: true,
			data: {
				bundle_id: "golden",
				status: "pending",
				eligible_sets: 2,
				checked_sets: 2,
				counts: { synced: 1, pending: 1, drift: 0, error: 0, unchecked: 0, stale: 0 },
				sets: [],
			},
		}))
		const api = new LLMGatewayAPI(fetcher, () => "cluster-token")

		await expect(api.getChannelBundleDeliveryStatus("golden")).resolves.toMatchObject({
			status: "pending",
			counts: { pending: 1 },
		})
		expect(fetcher).toHaveBeenCalledWith(
			"/api/channel-bundles/golden/delivery-status",
			expect.objectContaining({ auth: true }),
		)
	})

  it("exports and restores a secret-bearing desired config", async () => {
    const desiredConfig = {
      api_version: "llmgateway.io/v1alpha1",
      kind: "DesiredConfig",
      source_set_id: "set-a",
      global_options: [{ key: "ModelRatio", value: "{\"auto\":1}" }],
      channel_bundles: [{
        id: "golden",
        name: "Golden channels",
        channels: [{ id: "auto", name: "Auto", type: 1, key: "sk-plain-backup" }],
      }],
    }
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(desiredConfig))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: [{ id: "golden" }] }))
    const api = new LLMGatewayAPI(fetcher, () => "cluster-token")

    await expect(
      api.exportDesiredConfig({ source_set_id: "set-a", id: "golden", name: "Golden channels" }),
    ).resolves.toMatchObject({ kind: "DesiredConfig", channel_bundles: [{ channels: [{ key: "sk-plain-backup" }] }] })
    await expect(api.importDesiredConfig(desiredConfig)).resolves.toMatchObject([{ id: "golden" }])

    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/desired-config/export", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ source_set_id: "set-a", id: "golden", name: "Golden channels" }),
      headers: expect.objectContaining({ Authorization: "Bearer cluster-token" }),
    }))
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/desired-config/import", expect.objectContaining({
      method: "POST",
      body: JSON.stringify(desiredConfig),
    }))
  })

  it("loads operator overview, jobs, tenant detail, and channel releases with bearer auth", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { generated_at: "2026-07-07T10:00:00Z", totals: { sets: 1 }, sets: [], channel_bundles: [], jobs: [], alerts: [] },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true, data: [{ name: "check_channel_drift", enabled: true }] }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { job_name: "check_channel_drift", status: "success" } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { tenant: { user_id: "usr/demo" }, keys: [] } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: [{ revision_id: "rev-1", bundle_id: "golden" }] }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { id: "run-1", bundle_id: "golden", items: [] } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { id: "run-1", bundle_id: "golden", items: [] } }))
    const api = new LLMGatewayAPI(fetcher, () => "cluster-token")

    await expect(api.getOverview()).resolves.toMatchObject({ totals: { sets: 1 } })
    await expect(api.listJobs()).resolves.toMatchObject([{ name: "check_channel_drift" }])
    await expect(api.runJob("check_channel_drift")).resolves.toMatchObject({ job_name: "check_channel_drift" })
    await expect(api.getTenantDetail("usr/demo")).resolves.toMatchObject({ tenant: { user_id: "usr/demo" } })
    await expect(api.listChannelBundleRevisions("golden")).resolves.toMatchObject([{ revision_id: "rev-1" }])
    await expect(api.createChannelBundleRelease("golden", { set_ids: ["set-a"] })).resolves.toMatchObject({ id: "run-1" })
    await expect(api.getChannelBundleRelease("run-1")).resolves.toMatchObject({ id: "run-1" })

    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/admin/overview", expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer cluster-token" }) }))
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/admin/jobs", expect.anything())
    expect(fetcher).toHaveBeenNthCalledWith(3, "/api/admin/jobs/check_channel_drift/run", expect.objectContaining({ method: "POST" }))
    expect(fetcher).toHaveBeenNthCalledWith(4, "/api/admin/tenants/usr%2Fdemo", expect.anything())
    expect(fetcher).toHaveBeenNthCalledWith(5, "/api/channel-bundles/golden/revisions", expect.anything())
    expect(fetcher).toHaveBeenNthCalledWith(6, "/api/channel-bundles/golden/releases", expect.objectContaining({ method: "POST" }))
    expect(fetcher).toHaveBeenNthCalledWith(7, "/api/channel-bundle-releases/run-1", expect.anything())
  })

  it("requeues failed BYOK sync tasks through the operator API", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: { requeued: 3 } }))
    const api = new LLMGatewayAPI(fetcher, () => "cluster-token")

    await expect(api.retryFailedBYOKSync()).resolves.toEqual({ requeued: 3 })
    expect(fetcher).toHaveBeenCalledWith(
      "/api/admin/byok-sync/retry",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer cluster-token" }),
      }),
    )
  })

  it("loads the independent background-jobs and tenant-statistics snapshots", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { generated_at: "2026-07-14T10:00:00Z", jobs: [], byok_sync: {}, observations: {} } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { ready: true, total: 349000, generated_at: "2026-07-14T10:00:00Z", stale: false } }))
    const api = new LLMGatewayAPI(fetcher, () => "cluster-token")

    await expect(api.getBackgroundJobs()).resolves.toMatchObject({ jobs: [] })
    await expect(api.getTenantStatistics()).resolves.toMatchObject({ ready: true, total: 349000 })
    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/admin/background-jobs", expect.anything())
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/admin/tenant-statistics", expect.anything())
  })

  it("previews and starts tenant deletion and empty-set decommission operations", async () => {
    const tenantPreview = {
      id: "tenant-delete-1",
      status: "previewed",
      target_count: 1,
      target_digest: "tenant-digest",
    }
    const setPreview = {
      set_id: "set-a",
      empty: true,
      digest: "set-digest",
      blockers: {},
    }
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, data: tenantPreview }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { ...tenantPreview, status: "queued" } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: [tenantPreview] }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: setPreview }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { id: "set-delete-1", set_id: "set-a", status: "pending", version: 1 } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: [{ id: "set-delete-1", set_id: "set-a", status: "pending" }] }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { id: "set-delete-1", set_id: "set-a", status: "cancelled" } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { id: "set-delete-2", set_id: "set-a", status: "pending" } }))
    const api = new LLMGatewayAPI(fetcher, () => "cluster-token")

    await expect(api.previewTenantDeletion({ user_ids: ["usr/demo"] })).resolves.toMatchObject({ id: "tenant-delete-1" })
    await expect(api.startTenantDeletion("tenant-delete-1", {
      expected_target_count: 1,
      expected_target_digest: "tenant-digest",
      idempotency_key: "delete-tenant-1",
    })).resolves.toMatchObject({ status: "queued" })
    await expect(api.listTenantDeletions()).resolves.toHaveLength(1)
    await expect(api.previewSetDecommission("set-a")).resolves.toMatchObject({ empty: true })
    await expect(api.startSetDecommission({
      set_id: "set-a",
      expected_digest: "set-digest",
      idempotency_key: "delete-set-1",
      cascade_tenants: true,
      allow_orphan: false,
    })).resolves.toMatchObject({ id: "set-delete-1" })
    await expect(api.listSetDecommissions()).resolves.toHaveLength(1)
    await expect(api.cancelSetDecommission("set-delete-1", {
      expected_version: 1,
      idempotency_key: "cancel-set-delete-1",
    })).resolves.toMatchObject({ status: "cancelled" })
    await expect(api.retrySetDecommission("set-delete-2", {
      expected_version: 4,
      idempotency_key: "retry-set-delete-2",
    })).resolves.toMatchObject({ status: "pending" })

    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/admin/tenant-deletions/preview", expect.objectContaining({ method: "POST" }))
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/admin/tenant-deletions/tenant-delete-1/start", expect.objectContaining({ method: "POST" }))
    expect(fetcher).toHaveBeenNthCalledWith(3, "/api/admin/tenant-deletions?limit=100", expect.anything())
    expect(fetcher).toHaveBeenNthCalledWith(4, "/api/admin/set-decommissions/preview", expect.objectContaining({ body: JSON.stringify({ set_id: "set-a" }) }))
    expect(fetcher).toHaveBeenNthCalledWith(5, "/api/admin/set-decommissions", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        set_id: "set-a",
        expected_digest: "set-digest",
        idempotency_key: "delete-set-1",
        cascade_tenants: true,
        allow_orphan: false,
      }),
    }))
    expect(fetcher).toHaveBeenNthCalledWith(6, "/api/admin/set-decommissions?limit=100", expect.anything())
    expect(fetcher).toHaveBeenNthCalledWith(7, "/api/admin/set-decommissions/set-delete-1/cancel", expect.objectContaining({ method: "POST" }))
    expect(fetcher).toHaveBeenNthCalledWith(8, "/api/admin/set-decommissions/set-delete-2/retry", expect.objectContaining({ method: "POST" }))
  })

  it("reconciles set capacity with adjustable per-set watermarks", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        data: {
          policy: {
            source: "kro",
            namespace: "llmgateway-kro-demo",
            fleet: "fleet-demo",
            max_users_per_set: 5000,
            target_utilization: 0.6,
            min_ready_free_users: 1200,
            max_scale_up_per_cycle: 2,
          },
          ready_sets: 2,
          ready_free_users: 1600,
          required_free_users: 3000,
          deficit_users: 1400,
          created_requests: 1,
          sets: [
            {
              set_id: "set-a",
              status: "active",
              ready: true,
              user_count: 4400,
              free_users: 600,
              max_users: 5000,
              utilization: "0.88",
            },
          ],
          requests: [{ id: "kro:llmgateway-kro-demo:fleet-demo:set-auto-1", set_id: "set-auto-1" }],
        },
      }),
    )
    const api = new LLMGatewayAPI(fetcher, () => "cluster-token")

    await expect(
      api.reconcileSetCapacity({
        source: "kro",
        namespace: "llmgateway-kro-demo",
        fleet: "fleet-demo",
        max_users_per_set: 5000,
        target_utilization: 0.6,
        min_ready_free_users: 1200,
        max_scale_up_per_cycle: 2,
      }),
    ).resolves.toMatchObject({
      policy: { max_users_per_set: 5000, target_utilization: 0.6 },
      created_requests: 1,
      sets: [{ set_id: "set-a", max_users: 5000 }],
    })

    expect(fetcher).toHaveBeenCalledWith(
      "/api/admin/set-capacity/reconcile",
      expect.objectContaining({
        method: "POST",
        auth: true,
        headers: expect.objectContaining({ Authorization: "Bearer cluster-token" }),
        body: JSON.stringify({
          source: "kro",
          namespace: "llmgateway-kro-demo",
          fleet: "fleet-demo",
          max_users_per_set: 5000,
          target_utilization: 0.6,
          min_ready_free_users: 1200,
          max_scale_up_per_cycle: 2,
        }),
      }),
    )
  })

  it("runs chat completion probes through the control API", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        data: {
          mode: "gateway",
          endpoint: "/v1/chat/completions",
          upstream_status: 200,
          duration_ms: 18,
          response: {
            id: "chatcmpl-probe",
            model: "minimax-m2.7",
            choices: [
              {
                finish_reason: "stop",
                message: { role: "assistant", content: "LLMGateway endpoint is ready." },
              },
            ],
            usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
          },
        },
      }),
    )
    const api = new LLMGatewayAPI(fetcher, () => "cluster-token")

    await expect(
      api.runChatCompletionProbe({
        mode: "gateway",
        apiKey: "llmgw-probe",
        model: "minimax-m2.7",
        prompt: "ping",
      }),
    ).resolves.toMatchObject({
      content: "LLMGateway endpoint is ready.",
      model: "minimax-m2.7",
      total_tokens: 19,
    })

    expect(fetcher).toHaveBeenCalledWith(
      "/api/admin/traffic-probe",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cluster-token",
        },
        body: JSON.stringify({
          mode: "gateway",
          api_key: "llmgw-probe",
          model: "minimax-m2.7",
          prompt: "ping",
        }),
      }),
    )
  })

  it("uses the fixed user probe key when no API key is supplied", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        data: {
          mode: "gateway",
          user_id: "probe-user",
          set_id: "set-a",
          key_id: "key-probe",
          key_created: false,
          endpoint: "/v1/chat/completions",
          upstream_status: 200,
          duration_ms: 12,
          response: { choices: [{ message: { content: "ok" } }] },
        },
      }),
    )
    const api = new LLMGatewayAPI(fetcher, () => "cluster-token")

    await expect(api.runChatCompletionProbe({
      mode: "gateway",
      userID: "probe-user",
      model: "auto",
      prompt: "ping",
    })).resolves.toMatchObject({ key_id: "key-probe", key_created: false })

    expect(fetcher).toHaveBeenCalledWith(
      "/api/admin/traffic-probe",
      expect.objectContaining({
        body: JSON.stringify({
          mode: "gateway",
          user_id: "probe-user",
          model: "auto",
          prompt: "ping",
        }),
      }),
    )
  })

  it("manages whitelisted database resources with bearer auth", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: [{ id: "tenants", primary_key: "user_id", columns: [{ key: "user_id", primary: true }] }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            resource: { id: "tenants", primary_key: "user_id", columns: [{ key: "user_id", primary: true }] },
            rows: [{ id: "user-1", values: { user_id: "user-1", status: "active" } }],
            total: 1,
            limit: 25,
            offset: 0,
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            resource: { id: "tenants", primary_key: "user_id" },
            row: { id: "usr/demo", values: { user_id: "usr/demo", display_name: "Demo" } },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            resource: { id: "tenants", primary_key: "user_id" },
            row: { id: "usr/demo", values: { user_id: "usr/demo", display_name: "Demo User" } },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            resource: { id: "tenants", primary_key: "user_id" },
            row: { id: "usr/demo", values: { user_id: "usr/demo", status: "disabled" } },
          },
        }),
      )
    const api = new LLMGatewayAPI(fetcher, () => "cluster-token")

    await expect(api.listResources()).resolves.toEqual([
      { id: "tenants", primary_key: "user_id", columns: [{ key: "user_id", primary: true }] },
    ])
    await expect(api.listResourceRows("tenants", { limit: 25, offset: 0 })).resolves.toMatchObject({
      total: 1,
      rows: [{ id: "user-1", values: { status: "active" } }],
    })
    await expect(api.getResourceRow("tenants", "usr/demo")).resolves.toMatchObject({
      row: { id: "usr/demo", values: { display_name: "Demo" } },
    })
    await expect(api.patchResourceRow("tenants", "usr/demo", { display_name: "Demo User" })).resolves.toMatchObject({
      row: { values: { display_name: "Demo User" } },
    })
    await expect(api.runResourceAction("tenants", "disable", "usr/demo")).resolves.toMatchObject({
      row: { values: { status: "disabled" } },
    })

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "/api/admin/resources",
      expect.objectContaining({
        auth: true,
        headers: expect.objectContaining({ Authorization: "Bearer cluster-token" }),
      }),
    )
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "/api/admin/resources/tenants/rows?limit=25&offset=0",
      expect.objectContaining({ auth: true }),
    )
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      "/api/admin/resources/tenants/rows/usr%2Fdemo",
      expect.objectContaining({ auth: true }),
    )
    expect(fetcher).toHaveBeenNthCalledWith(
      4,
      "/api/admin/resources/tenants/rows/usr%2Fdemo",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ values: { display_name: "Demo User" } }),
      }),
    )
    expect(fetcher).toHaveBeenNthCalledWith(
      5,
      "/api/admin/resources/tenants/actions/disable",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ id: "usr/demo", params: undefined }),
      }),
    )
  })

  it("omits bearer auth when no admin token is configured", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: [] }))
    const api = new LLMGatewayAPI(fetcher, () => null)

    await api.listSets()

    expect(fetcher).toHaveBeenCalledWith(
      "/api/sets",
      expect.objectContaining({
        headers: {
          "Content-Type": "application/json",
        },
      }),
    )
  })
})
