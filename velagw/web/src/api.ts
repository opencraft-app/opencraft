export type GatewayResponse<T> = {
  success: boolean
  message?: string
  data?: T
}

export type AdminToken = {
  token: string
}

export type GatewaySet = {
  id: string
  name: string
  base_url: string
  traffic_base_url?: string
  status: "active" | "draining" | "disabled" | string
  setup: boolean
  admin_user_id: number
  max_users?: number
  warn_users?: number
  reserved_users?: number
  observed_user_count?: number
  capacity_updated_at?: string
  shard_id?: string
  newapi_replicas?: number
  sql_max_open_conns?: number
  sql_max_idle_conns?: number
  admission_status?: "pending" | "checking" | "passed" | "failed" | string
  admission_error?: string
  admission_checked_at?: string
  admin_image?: string
	  release_ring_id?: string
	  current_release_id?: string
	  target_release_id?: string
  active_runtime_generation?: number
  route_revision?: number
  created_at: string
  updated_at: string
}

export type SetUpgradeRun = {
  id: string
  batch_id: string
  set_id: string
  target_image: string
	  from_release_id?: string
	  target_release_id?: string
	  sequence?: number
  from_generation: number
  to_generation: number
  status: string
  switched_at?: string
  drain_deadline?: string
  rollback_deadline?: string
  last_error?: string
  rollback_requested?: boolean
}

export type NewAPIRelease = {
  id: string
  source: string
  namespace: string
  fleet: string
  version: string
  image: string
  compatibility: string
  status: "draft" | "verified" | "stable" | "blocked" | string
  created_at: string
  updated_at: string
}

export type ReleaseRing = {
  id: string
  name: string
  ordinal: number
  serving_release_id: string
  target_release_id?: string
  status: string
  admission_enabled: boolean
  max_parallel: number
  soak_seconds: number
  set_count: number
  release_distribution?: Record<string, number>
}

export type ReleaseRollout = {
  id: string
  ring_id: string
  target_release_id: string
  batch_id: string
  status: string
  total_sets: number
  completed_sets: number
  failed_sets: number
  current_set_id?: string
  batch?: SetUpgradeBatch
  created_at: string
  updated_at: string
}

export type SetUpgradeBatch = {
  id: string
  target_image: string
  status: string
  max_parallel: number
  stop_on_failure: boolean
  runs: SetUpgradeRun[]
  created_at: string
  updated_at: string
}

export type RegisterSetInput = {
  id: string
  name: string
  base_url: string
  traffic_base_url?: string
  status: string
  max_users?: number
  warn_users?: number
  reserved_users?: number
  shard_id?: string
  newapi_replicas?: number
  sql_max_open_conns?: number
  sql_max_idle_conns?: number
}

export type Shard = {
  id: string
  name: string
  kind: "mysql" | string
  endpoint?: string
  status: "active" | "disabled" | string
  max_connections?: number
  reserved_connections?: number
  warn_ratio?: number
  critical_ratio?: number
  created_at: string
  updated_at: string
}

export type UpsertShardInput = {
  id: string
  name?: string
  kind?: string
  endpoint?: string
  status?: string
  max_connections?: number
  reserved_connections?: number
  warn_ratio?: number
  critical_ratio?: number
}

export type ShardSetBudget = {
  set_id: string
  name: string
  status: string
  setup: boolean
  newapi_replicas: number
  sql_max_open_conns: number
  sql_max_idle_conns: number
  logical_connections: number
}

export type ShardDetail = {
  shard: Shard
  allocatable_connections: number
  logical_connections: number
  remaining_connections: number
  utilization: number
  capacity_status: "unknown" | "ok" | "warn" | "critical" | string
  sets: ShardSetBudget[]
}

export type EntitlementPlan = {
  id: string
  name: string
  monthly_tokens: number
  period_value: number
  period_unit: string
  is_active: boolean
  fingerprint: string
  created_at?: string
  updated_at?: string
}

export type PlanPeriod = {
  plan_id: string
  period_value: number
  period_unit: string
  created_at?: string
  updated_at?: string
}

export type CreateEntitlementPlanInput = {
  id?: string
  name: string
  monthly_tokens: number
  period_value: number
  period_unit: string
  is_active: boolean
}

export type SetPlanState = {
  plan_id: string
  set_id: string
  upstream_plan_id?: number
  status: "pending" | "syncing" | "ready" | "error" | string
  attempts?: number
  last_error?: string
  synced_at?: string
  updated_at?: string
}

export type SetPlanPeriodState = SetPlanState & {
  period_value: number
  period_unit: string
}

export type CreateExternalKeyResult = {
  external_key: string
  external_key_id: string
  set_id: string
  upstream_key_id: number
}

export type UserState = {
  user_id: string
  backend: "pending" | "new" | string
  set_id?: string
  upstream_user_id?: number
  username?: string
  current_plan_id?: string
  last_applied_plan_id?: string
  subscription_status?: string
  has_active_subscription: boolean
  token_balance: number
  credit_available: number
  credit_status: "ok" | "not_found" | "unavailable" | "error" | string
  credit_error?: string
  unlimited?: boolean
  period_start?: string
  period_end?: string
  source: string
}

export type TenantObservation = {
  user_id: string
  backend: "pending" | "new" | string
  set_id?: string
  upstream_user_id?: number
  username?: string
  current_plan_id?: string
  last_applied_plan_id?: string
  subscription_status?: string
  has_active_subscription: boolean
  token_balance: number
  credit_available: number
  credit_status: "ok" | "not_found" | "unavailable" | "error" | string
  credit_error?: string
  unlimited?: boolean
  period_start?: string
  period_end?: string
  source: string
  observed_at: string
  created_at?: string
  updated_at?: string
}

export type TenantSummary = {
  user_id: string
  backend: "pending" | "new" | string
  set_id?: string
  status: "active" | "disabled" | "deleted" | string
  source?: string
  display_name?: string
  upstream_user_id?: number
  username?: string
  last_plan_id?: string
  provision_status?: "allocated" | "user_ready" | "token_ready" | "failed" | string
  last_provision_error?: string
  key_count: number
  observed_plan_id?: string
  observed_credit_available?: number
  observed_credit_status?: string
  observed_subscription_status?: string
  observed_at?: string
  assignment_status: "explicit" | "bound_unassigned" | "tenant" | string
  migrated_at?: string
  created_at: string
  updated_at: string
}

export type TenantListResult = {
  items: TenantSummary[]
  total: number | null
  limit: number
  offset: number
  next_cursor?: string
  has_more: boolean
}

export type TenantListFilters = {
  keyword?: string
  backend?: string
  set_id?: string
  cursor?: string
  limit?: number
  offset?: number
  include_total?: boolean
}

export type TenantStatisticsSnapshot = {
  ready: boolean
  total: number | null
  new_total: number | null
  pending_total: number | null
  active_total: number | null
  disabled_total: number | null
  deleted_total: number | null
  generated_at: string | null
  stale: boolean
}

export type ChannelBundleChannel = {
  id: string
  name: string
  type: number
  key?: string
  key_hash?: string
  base_url?: string
  models?: string
  group?: string
  model_mapping?: string
  priority?: number
  weight?: number
  status?: "enabled" | "disabled" | string
  setting?: string
  param_override?: string
  header_override?: string
  remark?: string
  auto_ban?: number
  tag?: string
  other?: string
  status_code_mapping?: string
  settings?: string
  openai_organization?: string
  test_model?: string
  is_multi_key?: boolean
  multi_key_mode?: "random" | "polling" | string
}

export type ChannelBundleOption = {
  key: string
  value: unknown
}

export type ChannelBundleSpec = {
  version?: number
  kind?: string
  options?: ChannelBundleOption[]
  channels: ChannelBundleChannel[]
}

export type ChannelBundle = {
  id: string
  name: string
  description?: string
  source_set_id?: string
  spec: ChannelBundleSpec
  fingerprint?: string
  created_at?: string
  updated_at?: string
}

export type ChannelBundleRevision = {
  revision_id: string
  bundle_id: string
  version?: number
  name?: string
  description?: string
  source_set_id?: string
  spec?: ChannelBundleSpec
  fingerprint?: string
  created_at?: string
}

export type ChannelBundleSyncState = {
  bundle_id: string
  set_id: string
  status: "synced" | "pending" | "drift" | "error" | "skipped" | "conflict" | string
  last_error?: string
  desired_fingerprint?: string
  actual_fingerprint?: string
  applied_fingerprint?: string
  diff_json?: string
  remote_resources_json?: string
  last_synced_at?: string
  last_checked_at?: string
}

export type ChannelBundleDeliveryCounts = {
  synced: number
  pending: number
  drift: number
  error: number
  unchecked: number
  stale: number
}

export type ChannelBundleDeliverySetStatus = {
  set_id: string
  set_name: string
  status: "empty" | "synced" | "pending" | "drift" | "error" | "unchecked" | "stale" | string
  last_checked_at?: string
  last_error?: string
  diff_json?: string
}

export type ChannelBundleDeliveryStatus = {
  bundle_id: string
  status: "empty" | "synced" | "pending" | "drift" | "error" | "unchecked" | "stale" | string
  eligible_sets: number
  checked_sets: number
  coverage_checked_at?: string
  stale_after_seconds?: number | null
  has_stale_results: boolean
  counts: ChannelBundleDeliveryCounts
  sets: ChannelBundleDeliverySetStatus[]
}

export type ChannelBundleReleaseItem = {
  run_id: string
  bundle_id: string
  set_id: string
  status: "running" | "success" | "partial" | "error" | "skipped" | string
  last_error?: string
  started_at?: string
  finished_at?: string
}

export type ChannelBundleReleaseRun = {
  id: string
  bundle_id: string
  revision_id?: string
  fingerprint?: string
  status: "running" | "success" | "partial" | "error" | "skipped" | string
  force_drift?: boolean
  stop_on_failure: boolean
  triggered_by?: string
  last_error?: string
  items: ChannelBundleReleaseItem[]
  created_at?: string
  started_at?: string
  finished_at?: string
}

export type ChannelBundlePlan = {
  bundle_id: string
  set_id: string
  status: string
  last_error?: string
  desired_fingerprint?: string
  actual_fingerprint?: string
  desired: ChannelBundleSpec
  actual: ChannelBundleSpec
  steps: Array<{
    kind: string
    resource_id: string
    remote_id?: number
    action: string
    requires_force?: boolean
    reason?: string
  }>
  diff: {
    added?: Array<Record<string, unknown>>
    changed?: Array<Record<string, unknown>>
    extra?: Array<Record<string, unknown>>
    synced?: Array<Record<string, unknown>>
  }
  state?: ChannelBundleSyncState
}

export type SyncChannelBundleInput = {
  set_id: string
  force_drift?: boolean
}

export type ChannelBundleReleaseInput = {
  revision_id?: string
  set_ids?: string[]
  force_drift?: boolean
  stop_on_failure?: boolean
  triggered_by?: string
}

export type ImportChannelBundleInput = {
  source_set_id: string
  id: string
  name: string
  description?: string
  include_disabled?: boolean
}

export type DesiredConfig = {
  api_version: "llmgateway.io/v1alpha1" | string
  kind: "DesiredConfig" | string
  exported_at?: string
  source_set_id?: string
  global_options?: ChannelBundleOption[]
  channel_bundles: Array<{
    id: string
    name: string
    description?: string
    channels: Array<ChannelBundleChannel & { key: string }>
  }>
}

export type TrafficProbeMode = "gateway" | "set_direct"

export type ChatCompletionProbeInput = {
  mode: TrafficProbeMode
  apiKey?: string
  userID?: string
  model: string
  prompt: string
}

export type ChatCompletionProbeResult = {
  mode: TrafficProbeMode
  user_id?: string
  set_id?: string
  key_id?: string
  key_created?: boolean
  endpoint: string
  upstream_status: number
  duration_ms: number
  id?: string
  model?: string
  content: string
  finish_reason?: string
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  raw: unknown
}

export type ResourceColumn = {
  key: string
  label?: string
  type?: string
  primary?: boolean
  sensitive?: boolean
  editable?: boolean
}

export type ResourceAction = {
  id: string
  label?: string
  description?: string
}

export type ResourceDefinition = {
  id: string
  label?: string
  description?: string
  primary_key: string
  read_only?: boolean
  columns?: ResourceColumn[]
  actions?: ResourceAction[]
}

export type ResourceRow = {
  id: string
  values: Record<string, unknown>
}

export type ResourceRowsResult = {
  resource: ResourceDefinition
  rows: ResourceRow[]
  total: number
  limit: number
  offset: number
}

export type ResourceRowResult = {
  resource: ResourceDefinition
  row: ResourceRow
}

export type ResourceRowsFilters = {
  limit?: number
  offset?: number
}

export type SetCapacityPolicy = {
  source?: string
  namespace: string
  fleet: string
  shard_refs?: string[]
  max_users_per_set?: number
  target_utilization?: number
  min_ready_free_users?: number
  min_warm_sets?: number
  max_scale_up_per_cycle?: number
  set_id_prefix?: string
  redis_db_start?: number
  redis_db_limit?: number
}

export type SetCapacitySetSnapshot = {
  set_id: string
  status: string
  ready: boolean
  accepting_new_users?: boolean
  capacity_status?: string
  user_count: number
  free_users: number
  max_users: number
  warn_users?: number
  reserved_users?: number
  utilization: string
}

export type SetProvisionRequest = {
  id: string
  source?: string
  namespace?: string
  fleet?: string
  set_id: string
  shard_ref?: string
  database_name?: string
  redis_db?: string
  status?: string
  reason?: string
  requested_users?: number
  max_users_per_set?: number
}

export type SetCapacityResult = {
  policy: SetCapacityPolicy
  ready_sets: number
  ready_free_users: number
  required_free_users: number
  inflight_requests: number
  inflight_free_users: number
  deficit_users: number
  created_requests: number
  sets: SetCapacitySetSnapshot[]
  requests: SetProvisionRequest[]
}

export type WorkerJob = {
  name: string
  kind?: string
  enabled: boolean
  interval_seconds?: number
  status?: string
  lease_owner?: string
  lease_until?: string
  last_started_at?: string
  last_finished_at?: string
  last_success_at?: string
  next_run_at?: string
  cursor?: string
  last_error?: string
  failure_count?: number
}

export type WorkerJobRun = {
  id?: string
  job_name: string
  owner?: string
  status: string
  started_at?: string
  finished_at?: string
  error?: string
  detail?: string
}

export type OperationalAlert = {
  kind: string
  severity: "critical" | "warning" | string
  message: string
  set_id?: string
  bundle_id?: string
  job_name?: string
  created_at?: string
}

export type OperationalOverview = {
  generated_at: string
  totals: {
    sets: number
    active_sets: number
    ready_sets?: number
    users: number
    available_user_slots?: number
    full_sets?: number
    channel_drifts: number
  }
  sets: Array<{
    id: string
    name?: string
    status: string
    setup: boolean
    ready: boolean
    user_count: number
    max_users?: number
    warn_users?: number
    reserved_users?: number
    free_users?: number
    accepting_new_users?: boolean
    capacity_status?: string
    capacity_updated_at?: string
    admission_status?: string
    admission_error?: string
    admission_checked_at?: string
    last_error?: string
    last_error_at?: string
    last_reconciled_at?: string
    last_provision_status?: string
    updated_at?: string
  }>
  channel_bundles: Array<{
    bundle_id: string
    name: string
    fingerprint?: string
    synced_sets: number
    pending_sets: number
    drift_sets: number
    error_sets: number
    skipped_sets: number
    last_checked_at?: string
    last_error?: string
  }>
  alerts: OperationalAlert[]
  traffic_errors?: Array<{
    set_id?: string
    status: number
    upstream_status: number
    error_type: string
    count: number
  }>
}

export type BYOKSyncQueueStats = {
  pending: number
  running: number
  error: number
  succeeded: number
  total_open: number
  expired_running_leases?: number
  oldest_pending_at?: string
  oldest_pending_age_seconds?: number
  oldest_error_at?: string
  oldest_error_age_seconds?: number
  last_success_at?: string
  last_failure_at?: string
  last_calculated_at?: string
}

export type TenantObservationQueueStats = {
  pending: number
  due: number
  running: number
  error: number
  blocked: number
  expired_running_leases: number
  oldest_due_at?: string
  oldest_due_age_seconds: number
  last_success_at?: string
  last_failure_at?: string
  last_calculated_at?: string
}

export type BackgroundJobsOverview = {
  generated_at: string
  jobs: WorkerJob[]
  byok_sync: BYOKSyncQueueStats
  observations: TenantObservationQueueStats
}

export type APIKeySummary = {
  external_key_id: string
  set_id: string
  user_id: string
  upstream_key_id?: number
  key_hash_prefix?: string
  created_at?: string
}

export type TenantDetail = {
  tenant: TenantSummary
  assignment?: Record<string, unknown>
  binding?: Record<string, unknown>
  keys: APIKeySummary[]
  observation?: TenantObservation
  llm_settings?: Record<string, unknown>
  recent_errors?: Array<{ kind: string; message: string; at?: string; reference?: string }>
}

export type TenantDeletionPreviewInput = {
  user_ids?: string[]
  user_id_prefix?: string
  set_id?: string
}

export type TenantDeletionStartInput = {
  expected_target_count: number
  expected_target_digest: string
  idempotency_key: string
}

export type TenantDeletionJob = {
  id: string
  status: "materializing" | "previewed" | "claiming" | "queued" | "running" | "paused" | "partial" | "error" | "succeeded" | string
  selector_type: string
  selector_value?: string
  user_ids?: string[]
  snapshot_at?: string
  target_count: number
  target_digest: string
  claimed_count?: number
  success_count?: number
  failure_count?: number
  last_error?: string
  version: number
  created_at?: string
  updated_at?: string
}

export type SetDecommissionBlockers = {
  tenants?: number
  user_bindings?: number
  api_keys?: number
  assignments?: number
  byok_settings?: number
  byok_tasks?: number
  observations?: number
  observation_tasks?: number
  subscription_overlays?: number
  group_ratio_intents?: number
  deletion_targets?: number
  active_operation_leases?: number
  runtime_leases?: number
}

export type SetDecommissionPreview = {
  set_id: string
  empty: boolean
  digest: string
  blockers: SetDecommissionBlockers
}

export type SetDecommissionStartInput = {
  set_id: string
  expected_digest: string
  idempotency_key: string
  cascade_tenants?: boolean
  allow_orphan?: boolean
}

export type SetDecommissionJob = {
  id: string
  set_id: string
  status: "purging_tenants" | "pending" | "removing_runtime" | "cleaning_runtime" | "finalizing" | "cleanup_ack_pending" | "error" | "cancelled" | "succeeded" | string
  previous_set_status?: string
  lifecycle_generation?: number
  cascade_tenants?: boolean
  allow_orphan?: boolean
  attempt?: number
  claim_owner?: string
  claim_lease_until?: string
  job_uid?: string
  version: number
  last_error?: string
  created_at?: string
  updated_at?: string
}

type TokenProvider = () => string | null | undefined

type ViteImportMeta = ImportMeta & {
  env?: Record<string, string | undefined>
}

type ProcessGlobal = typeof globalThis & {
  process?: {
    env?: Record<string, string | undefined>
  }
}

function defaultTokenProvider() {
  return (
    (import.meta as ViteImportMeta).env?.VITE_CLUSTER_ADMIN_TOKEN ||
    (globalThis as ProcessGlobal).process?.env?.VITE_CLUSTER_ADMIN_TOKEN ||
    ""
  ).trim()
}

export class APIError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "APIError"
    this.status = status
  }
}

export class LLMGatewayAPI {
  private fetcher: typeof fetch
  private tokenProvider: TokenProvider

  constructor(fetcher: typeof fetch = fetch, tokenProvider: TokenProvider = defaultTokenProvider) {
    this.fetcher = fetcher.bind(globalThis)
    this.tokenProvider = tokenProvider
  }

  login(input: { username: string; password: string }) {
    return this.request<AdminToken>("/api/admin/login", {
      method: "POST",
      body: JSON.stringify(input),
    })
  }

  logout() {
    return this.request<void>("/api/admin/logout", {
      method: "POST",
    })
  }

  listSets() {
    return this.request<GatewaySet[]>("/api/sets", {
      auth: true,
    })
  }

  listSetUpgradeRuns(setID: string, limit = 20) {
    const params = new URLSearchParams({ set_id: setID, limit: String(limit) })
    return this.request<SetUpgradeRun[]>(`/api/admin/set-upgrade-runs?${params.toString()}`, { auth: true })
  }

  createSetUpgrade(input: { set_ids: string[]; target_image: string; max_parallel?: number }) {
    return this.request<SetUpgradeBatch>("/api/admin/set-upgrades", {
      method: "POST",
      auth: true,
      body: JSON.stringify({ ...input, stop_on_failure: true, drain_timeout_seconds: 330, rollback_window_seconds: 300 }),
    })
  }

  rollbackSetUpgrade(runID: string, reason: string) {
    return this.request<SetUpgradeRun>(`/api/admin/set-upgrade-runs/${encodeURIComponent(runID)}/rollback`, {
      method: "POST",
      auth: true,
      body: JSON.stringify({ reason }),
    })
  }

  retrySetUpgrade(runID: string) {
    return this.request<SetUpgradeRun>(`/api/admin/set-upgrade-runs/${encodeURIComponent(runID)}/retry`, {
      method: "POST",
      auth: true,
    })
  }

  listNewAPIReleases() {
    return this.request<NewAPIRelease[]>("/api/admin/newapi-releases", { auth: true })
  }

  createNewAPIRelease(input: { id: string; version: string; image: string; status?: string }) {
    return this.request<NewAPIRelease>("/api/admin/newapi-releases", {
      method: "POST",
      auth: true,
      body: JSON.stringify({ ...input, compatibility: "expand_compatible", status: input.status || "verified" }),
    })
  }

  listReleaseRings() {
    return this.request<ReleaseRing[]>("/api/admin/release-rings", { auth: true })
  }

  upsertReleaseRing(input: {
    id: string
    name: string
    ordinal: number
    serving_release_id: string
    admission_enabled: boolean
    set_ids: string[]
  }) {
    return this.request<ReleaseRing>("/api/admin/release-rings", {
      method: "POST",
      auth: true,
      body: JSON.stringify({ ...input, max_parallel: 1, soak_seconds: 1800 }),
    })
  }

  listReleaseRollouts(ringID = "") {
    const params = new URLSearchParams()
    if (ringID) params.set("ring_id", ringID)
    params.set("limit", "50")
    return this.request<ReleaseRollout[]>(`/api/admin/release-rollouts?${params.toString()}`, { auth: true })
  }

  createReleaseRollout(input: { ring_id: string; target_release_id: string }) {
    return this.request<ReleaseRollout>("/api/admin/release-rollouts", {
      method: "POST",
      auth: true,
      body: JSON.stringify({ ...input, drain_timeout_seconds: 330, rollback_window_seconds: 300 }),
    })
  }

  listShards() {
    return this.request<ShardDetail[]>("/api/admin/shards", {
      auth: true,
    })
  }

  listPlans() {
    return this.request<EntitlementPlan[]>("/api/plans", {
      auth: true,
    })
  }

  createPlan(input: CreateEntitlementPlanInput) {
    return this.request<EntitlementPlan>("/api/plans", {
      method: "POST",
      auth: true,
      body: JSON.stringify(input),
    })
  }

  listPlanSetStates(planID: string) {
    return this.request<SetPlanState[]>(`/api/plans/${encodeURIComponent(planID)}/sets`, {
      auth: true,
    })
  }

  listPlanPeriods(planID: string) {
    return this.request<PlanPeriod[]>(`/api/plans/${encodeURIComponent(planID)}/periods`, {
      auth: true,
    })
  }

  listPlanPeriodSetStates(planID: string) {
    return this.request<SetPlanPeriodState[]>(`/api/plans/${encodeURIComponent(planID)}/periods/sets`, {
      auth: true,
    })
  }

  syncPlan(planID: string, setIDs: string[] = []) {
    return this.request<SetPlanState[]>(`/api/plans/${encodeURIComponent(planID)}/sync`, {
      method: "POST",
      auth: true,
      body: JSON.stringify({ set_ids: setIDs }),
    })
  }

  getShard(id: string) {
    return this.request<ShardDetail>(`/api/admin/shards/${encodeURIComponent(id)}`, {
      auth: true,
    })
  }

  upsertShard(input: UpsertShardInput) {
    return this.request<void>("/api/admin/shards", {
      method: "POST",
      auth: true,
      body: JSON.stringify(input),
    })
  }

  getOverview() {
    return this.request<OperationalOverview>("/api/admin/overview", {
      auth: true,
    })
  }

  getBackgroundJobs() {
    return this.request<BackgroundJobsOverview>("/api/admin/background-jobs", {
      auth: true,
    })
  }

  getTenantStatistics() {
    return this.request<TenantStatisticsSnapshot>("/api/admin/tenant-statistics", {
      auth: true,
    })
  }

  listJobs() {
    return this.request<WorkerJob[]>("/api/admin/jobs", {
      auth: true,
    })
  }

  runJob(name: string) {
    return this.request<WorkerJobRun>(
      `/api/admin/jobs/${encodeURIComponent(name)}/run`,
      {
        method: "POST",
        auth: true,
      },
    )
  }

  retryFailedBYOKSync() {
    return this.request<{ requeued: number }>("/api/admin/byok-sync/retry", {
      method: "POST",
      auth: true,
    })
  }

  registerSet(input: RegisterSetInput) {
    return this.request<void>("/api/sets", {
      method: "POST",
      auth: true,
      body: JSON.stringify(input),
    })
  }

  bootstrapSet(setID: string) {
    return this.request<GatewaySet>(`/api/sets/${encodeURIComponent(setID)}/bootstrap`, {
      method: "POST",
      auth: true,
    })
  }

  createExternalKey(externalUserID: string) {
    return this.request<CreateExternalKeyResult>(
      `/api/users/${encodeURIComponent(externalUserID)}/keys`,
      {
        method: "POST",
        auth: true,
      },
    )
  }

  getUserState(externalUserID: string) {
    return this.request<UserState>(
      `/api/admin/users/${encodeURIComponent(externalUserID)}/state`,
      {
        auth: true,
      },
    )
  }

  observeTenant(externalUserID: string) {
    return this.request<TenantObservation>(
      `/api/admin/users/${encodeURIComponent(externalUserID)}/observe`,
      {
        method: "POST",
        auth: true,
      },
    )
  }

  listTenants(filters: TenantListFilters = {}) {
    const params = new URLSearchParams()
    if (filters.keyword) params.set("keyword", filters.keyword)
    if (filters.backend) params.set("backend", filters.backend)
    if (filters.set_id) params.set("set_id", filters.set_id)
    if (filters.cursor) params.set("cursor", filters.cursor)
    if (filters.limit !== undefined) params.set("limit", String(filters.limit))
    if (filters.offset !== undefined) params.set("offset", String(filters.offset))
    if (filters.include_total !== undefined) params.set("include_total", String(filters.include_total))
    const query = params.toString()
    return this.request<TenantListResult>(`/api/admin/tenants${query ? `?${query}` : ""}`, {
      auth: true,
    })
  }

  getTenantDetail(externalUserID: string) {
    return this.request<TenantDetail>(
      `/api/admin/tenants/${encodeURIComponent(externalUserID)}`,
      {
        auth: true,
      },
    )
  }

  previewTenantDeletion(input: TenantDeletionPreviewInput) {
    return this.request<TenantDeletionJob>("/api/admin/tenant-deletions/preview", {
      method: "POST",
      auth: true,
      body: JSON.stringify(input),
    })
  }

  getTenantDeletion(jobID: string) {
    return this.request<TenantDeletionJob>(
      `/api/admin/tenant-deletions/${encodeURIComponent(jobID)}`,
      { auth: true },
    )
  }

  listTenantDeletions(status = "", limit = 100) {
    const params = new URLSearchParams({ limit: String(limit) })
    if (status) params.set("status", status)
    return this.request<TenantDeletionJob[]>(`/api/admin/tenant-deletions?${params.toString()}`, {
      auth: true,
    })
  }

  startTenantDeletion(jobID: string, input: TenantDeletionStartInput) {
    return this.request<TenantDeletionJob>(
      `/api/admin/tenant-deletions/${encodeURIComponent(jobID)}/start`,
      {
        method: "POST",
        auth: true,
        body: JSON.stringify(input),
      },
    )
  }

  previewSetDecommission(setID: string) {
    return this.request<SetDecommissionPreview>("/api/admin/set-decommissions/preview", {
      method: "POST",
      auth: true,
      body: JSON.stringify({ set_id: setID }),
    })
  }

  listSetDecommissions(status = "", limit = 100) {
    const params = new URLSearchParams({ limit: String(limit) })
    if (status) params.set("status", status)
    return this.request<SetDecommissionJob[]>(`/api/admin/set-decommissions?${params.toString()}`, {
      auth: true,
    })
  }

  startSetDecommission(input: SetDecommissionStartInput) {
    return this.request<SetDecommissionJob>("/api/admin/set-decommissions", {
      method: "POST",
      auth: true,
      body: JSON.stringify(input),
    })
  }

  cancelSetDecommission(jobID: string, input: { expected_version: number; idempotency_key: string }) {
    return this.request<SetDecommissionJob>(
      `/api/admin/set-decommissions/${encodeURIComponent(jobID)}/cancel`,
      {
        method: "POST",
        auth: true,
        body: JSON.stringify(input),
      },
    )
  }

  retrySetDecommission(jobID: string, input: { expected_version: number; idempotency_key: string }) {
    return this.request<SetDecommissionJob>(
      `/api/admin/set-decommissions/${encodeURIComponent(jobID)}/retry`,
      {
        method: "POST",
        auth: true,
        body: JSON.stringify(input),
      },
    )
  }

  runTenantAction<T = unknown>(externalUserID: string, action: string, body?: unknown) {
    return this.request<T>(
      `/api/admin/tenants/${encodeURIComponent(externalUserID)}/actions/${encodeURIComponent(action)}`,
      {
        method: "POST",
        auth: true,
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    )
  }

  listChannelBundles() {
    return this.request<ChannelBundle[]>("/api/channel-bundles", {
      auth: true,
    })
  }

  getChannelBundleDeliveryStatus(bundleID: string) {
    return this.request<ChannelBundleDeliveryStatus>(
      `/api/channel-bundles/${encodeURIComponent(bundleID)}/delivery-status`,
      { auth: true },
    )
  }

  saveChannelBundle(input: ChannelBundle) {
    return this.request<ChannelBundle>("/api/channel-bundles", {
      method: "POST",
      auth: true,
      body: JSON.stringify(input),
    })
  }

  planChannelBundle(bundleID: string, input: SyncChannelBundleInput) {
    return this.request<ChannelBundlePlan>(
      `/api/channel-bundles/${encodeURIComponent(bundleID)}/plan`,
      {
        method: "POST",
        auth: true,
        body: JSON.stringify(input),
      },
    )
  }

  importChannelBundle(input: ImportChannelBundleInput) {
    return this.request<ChannelBundle>("/api/channel-bundles/import", {
      method: "POST",
      auth: true,
      body: JSON.stringify(input),
    })
  }

  exportDesiredConfig(input: ImportChannelBundleInput) {
    return this.requestDocument<DesiredConfig>("/api/desired-config/export", {
      method: "POST",
      auth: true,
      body: JSON.stringify(input),
    })
  }

  importDesiredConfig(config: DesiredConfig) {
    return this.request<ChannelBundle[]>("/api/desired-config/import", {
      method: "POST",
      auth: true,
      body: JSON.stringify(config),
    })
  }

  applyChannelBundle(bundleID: string, input: SyncChannelBundleInput) {
    return this.request<ChannelBundleSyncState>(
      `/api/channel-bundles/${encodeURIComponent(bundleID)}/apply`,
      {
        method: "POST",
        auth: true,
        body: JSON.stringify(input),
      },
    )
  }

  listChannelBundleRevisions(bundleID: string) {
    return this.request<ChannelBundleRevision[]>(
      `/api/channel-bundles/${encodeURIComponent(bundleID)}/revisions`,
      {
        auth: true,
      },
    )
  }

  listChannelBundleReleases(bundleID: string) {
    return this.request<ChannelBundleReleaseRun[]>(
      `/api/channel-bundles/${encodeURIComponent(bundleID)}/releases`,
      {
        auth: true,
      },
    )
  }

  createChannelBundleRelease(bundleID: string, input: ChannelBundleReleaseInput) {
    return this.request<ChannelBundleReleaseRun>(
      `/api/channel-bundles/${encodeURIComponent(bundleID)}/releases`,
      {
        method: "POST",
        auth: true,
        body: JSON.stringify(input),
      },
    )
  }

  getChannelBundleRelease(runID: string) {
    return this.request<ChannelBundleReleaseRun>(
      `/api/channel-bundle-releases/${encodeURIComponent(runID)}`,
      {
        auth: true,
      },
    )
  }

  rollbackChannelBundle(bundleID: string, revisionID: string) {
    return this.request<ChannelBundle>(
      `/api/channel-bundles/${encodeURIComponent(bundleID)}/rollback`,
      {
        method: "POST",
        auth: true,
        body: JSON.stringify({ revision_id: revisionID }),
      },
    )
  }

  listResources() {
    return this.request<ResourceDefinition[]>("/api/admin/resources", {
      auth: true,
    })
  }

  listResourceRows(resourceID: string, filters: ResourceRowsFilters = {}) {
    const params = new URLSearchParams()
    if (filters.limit !== undefined) params.set("limit", String(filters.limit))
    if (filters.offset !== undefined) params.set("offset", String(filters.offset))
    const query = params.toString()
    return this.request<ResourceRowsResult>(
      `/api/admin/resources/${encodeURIComponent(resourceID)}/rows${query ? `?${query}` : ""}`,
      {
        auth: true,
      },
    )
  }

  getResourceRow(resourceID: string, rowID: string) {
    return this.request<ResourceRowResult>(
      `/api/admin/resources/${encodeURIComponent(resourceID)}/rows/${encodeURIComponent(rowID)}`,
      {
        auth: true,
      },
    )
  }

  patchResourceRow(resourceID: string, rowID: string, values: Record<string, unknown>) {
    return this.request<ResourceRowResult>(
      `/api/admin/resources/${encodeURIComponent(resourceID)}/rows/${encodeURIComponent(rowID)}`,
      {
        method: "PATCH",
        auth: true,
        body: JSON.stringify({ values }),
      },
    )
  }

  runResourceAction(resourceID: string, actionID: string, rowID: string, params?: Record<string, unknown>) {
    return this.request<ResourceRowResult>(
      `/api/admin/resources/${encodeURIComponent(resourceID)}/actions/${encodeURIComponent(actionID)}`,
      {
        method: "POST",
        auth: true,
        body: JSON.stringify({ id: rowID, params }),
      },
    )
  }

  reconcileSetCapacity(input: SetCapacityPolicy) {
    return this.request<SetCapacityResult>("/api/admin/set-capacity/reconcile", {
      method: "POST",
      auth: true,
      body: JSON.stringify(input),
    })
  }

  async runChatCompletionProbe(input: ChatCompletionProbeInput): Promise<ChatCompletionProbeResult> {
    const probe = await this.request<{
      mode: TrafficProbeMode
      user_id?: string
      set_id?: string
      key_id?: string
      key_created?: boolean
      endpoint: string
      upstream_status: number
      duration_ms: number
      response: unknown
    }>("/api/admin/traffic-probe", {
      method: "POST",
      auth: true,
      body: JSON.stringify({
        mode: input.mode,
        api_key: input.apiKey || undefined,
        user_id: input.userID || undefined,
        model: input.model,
        prompt: input.prompt,
      }),
    })
    const parsed = probe.response
    const choice = firstChoice(parsed)
    const content = choice?.message?.content || choice?.text || ""
    if (!content.trim()) {
      throw new APIError("Chat completion response did not include assistant content", probe.upstream_status)
    }
    const usage = typeof parsed === "object" && parsed !== null ? (parsed as { usage?: Record<string, number> }).usage : undefined
    return {
      mode: probe.mode,
      user_id: probe.user_id,
      set_id: probe.set_id,
      key_id: probe.key_id,
      key_created: probe.key_created,
      endpoint: probe.endpoint,
      upstream_status: probe.upstream_status,
      duration_ms: probe.duration_ms,
      id: typeof parsed === "object" && parsed !== null ? (parsed as { id?: string }).id : undefined,
      model: typeof parsed === "object" && parsed !== null ? (parsed as { model?: string }).model : undefined,
      content,
      finish_reason: choice?.finish_reason,
      prompt_tokens: usage?.prompt_tokens,
      completion_tokens: usage?.completion_tokens,
      total_tokens: usage?.total_tokens,
      raw: parsed,
    }
  }

  private async request<T>(
    path: string,
    init: RequestInit & { auth?: boolean } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    }
    if (init.auth) {
      const token = this.tokenProvider()
      if (token) {
        headers.Authorization = `Bearer ${token}`
      }
    }

    const response = await this.fetcher(path, {
      ...init,
      headers,
    })
    const envelope = (await response.json()) as GatewayResponse<T>
    if (!response.ok || !envelope.success) {
      throw new APIError(envelope.message || response.statusText || "Request failed", response.status)
    }
    return envelope.data as T
  }

  private async requestDocument<T>(
    path: string,
    init: RequestInit & { auth?: boolean } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    }
    if (init.auth) {
      const token = this.tokenProvider()
      if (token) headers.Authorization = `Bearer ${token}`
    }
    const response = await this.fetcher(path, { ...init, headers })
    const payload = (await response.json()) as T | GatewayResponse<unknown>
    if (!response.ok) {
      const envelope = payload as GatewayResponse<unknown>
      throw new APIError(envelope.message || response.statusText || "Request failed", response.status)
    }
    return payload as T
  }
}

function firstChoice(parsed: unknown) {
  if (typeof parsed !== "object" || parsed === null) {
    return undefined
  }
  const choices = (parsed as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) {
    return undefined
  }
  return choices[0] as {
    finish_reason?: string
    message?: { content?: string }
    text?: string
  }
}
