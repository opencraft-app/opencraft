import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";

interface CtlEnvelope<T> {
  data?: T;
}

export interface CtlBundle {
  bundle_id: string;
  bundle_name: string;
  bundle_type: string;
  description?: unknown;
  bundle_state: string;
  agent_quota: number;
  credit: number;
  time_span: number;
  time_unit: string;
  ai_gateway_plan_id?: string;
  instance_spec_id?: string;
  instance_spec_display?: string;
  cpu?: number;
  memory?: number;
  system_disk_size?: number;
  static_sold_out?: boolean;
  bundle_sales_available_count: number;
  bundle_sales_total_count: number;
  bundle_sales_state: string;
  created_time: string;
  updated_time: string;
}

export interface CtlPass {
  pass_id: string;
  user_id: string;
  bundle_id: string;
  bundle_name: string;
  uin: number;
  app_id: number;
  created_time: string;
  expired_time: string;
  isolated_time?: string | null;
  deleted_time?: string | null;
  updated_time: string;
  status: string;
  credit_total: number;
  credit_available: number;
  agent_quota_total: number;
  agent_quota_available: number;
  renew_flag: string;
}

export interface CtlRefundPassResult {
  pass_id: string;
  deal_name: string;
  big_deal_id: string;
  submitted_at: string;
}

export interface CtlDianshiOrder {
  id: number;
  big_order_id: string;
  deal_name: string;
  external_user_id: string;
  uin: string;
  app_id: string;
  bundle_id: string;
  order_type: string;
  status: string;
  resource_type: string;
  resource_id: string;
  activity_id: number;
  act_id: number;
  pay_url?: string;
  created_time: string;
  updated_time: string;
}

export interface CtlDianshiParticipation {
  id: number;
  uin: string;
  app_id: string;
  external_user_id: string;
  activity_id: number;
  bundle_id: string;
  act_id: number;
  deal_name: string;
  big_deal_no: string;
  created_time: string;
}

interface CtlBundleListData {
  bundles?: CtlBundle[];
}

interface CtlPassListData {
  passes?: CtlPass[];
}

interface CtlDeletePassResult {
  deleted: boolean;
}

export interface CtlPassFilters {
  userID?: string;
  bundleID?: string;
}

export interface CtlDianshiRecordFilters {
  userID?: string;
  uin?: string;
  activityID?: string;
  bundleID?: string;
  dealName?: string;
}

interface CtlDianshiRecordsData {
  orders?: CtlDianshiOrder[];
  participations?: CtlDianshiParticipation[];
}

interface CtlDeleteDianshiRecordResult {
  deleted: boolean;
  affected: number;
}

function unwrapCtlData<T>(envelope: CtlEnvelope<T>): T {
  if (envelope.data === undefined) {
    throw new Error("CTL 响应缺少 data 字段");
  }
  return envelope.data;
}

export function useCtlAdminBundles() {
  return useQuery({
    queryKey: ["ctl-admin", "bundles"],
    queryFn: async () => {
      const envelope = await apiClient<CtlEnvelope<CtlBundleListData>>("ctl/admin/bundles");
      return unwrapCtlData(envelope).bundles ?? [];
    },
  });
}

export function useCtlAdminPasses(filters: CtlPassFilters) {
  return useQuery({
    queryKey: ["ctl-admin", "passes", filters],
    queryFn: async () => {
      const envelope = await apiClient<CtlEnvelope<CtlPassListData>>("ctl/admin/passes", {
        params: {
          user_id: filters.userID || undefined,
          bundle_id: filters.bundleID || undefined,
        },
      });
      return unwrapCtlData(envelope).passes ?? [];
    },
  });
}

function hasDianshiRecordFilter(filters: CtlDianshiRecordFilters) {
  return Boolean(
    filters.userID?.trim() ||
    filters.uin?.trim() ||
    filters.activityID?.trim() ||
    filters.bundleID?.trim() ||
    filters.dealName?.trim()
  );
}

export function useCtlDianshiRecords(filters: CtlDianshiRecordFilters) {
  return useQuery({
    queryKey: ["ctl-admin", "dianshi-records", filters],
    enabled: hasDianshiRecordFilter(filters),
    queryFn: async () => {
      const envelope = await apiClient<CtlEnvelope<CtlDianshiRecordsData>>("ctl/admin/dianshi/orders", {
        params: {
          external_user_id: filters.userID?.trim() || undefined,
          uin: filters.uin?.trim() || undefined,
          activity_id: filters.activityID?.trim() || undefined,
          bundle_id: filters.bundleID?.trim() || undefined,
          deal_name: filters.dealName?.trim() || undefined,
          limit: 100,
        },
      });
      const data = unwrapCtlData(envelope);
      return {
        orders: data.orders ?? [],
        participations: data.participations ?? [],
      };
    },
  });
}

export function useCtlRefundPass() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      passID,
      operatorUin,
      reason,
    }: {
      passID: string;
      operatorUin?: number;
      reason?: string;
    }) =>
      apiClient<CtlEnvelope<CtlRefundPassResult>>(
        `ctl/admin/passes/${encodeURIComponent(passID)}/refund`,
        {
          method: "POST",
          body: {
            operator_uin: operatorUin || undefined,
            reason: reason || undefined,
          },
        }
      ).then(unwrapCtlData),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ctl-admin", "passes"] });
    },
  });
}

export function useCtlDestroyPass() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ passID, userID }: { passID: string; userID: string }) =>
      apiClient<CtlEnvelope<CtlDeletePassResult>>(
        `ctl/admin/passes/${encodeURIComponent(passID)}/delete`,
        {
          method: "POST",
          body: { user_id: userID },
        }
      ).then(unwrapCtlData),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ctl-admin", "passes"] });
    },
  });
}

export function useCtlDeleteDianshiOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (dealName: string) =>
      apiClient<CtlEnvelope<CtlDeleteDianshiRecordResult>>(
        `ctl/admin/dianshi/orders/${encodeURIComponent(dealName)}`,
        { method: "DELETE" }
      ).then(unwrapCtlData),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ctl-admin", "dianshi-records"] });
    },
  });
}

export function useCtlDeleteDianshiParticipation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiClient<CtlEnvelope<CtlDeleteDianshiRecordResult>>(
        `ctl/admin/dianshi/participations/${id}`,
        { method: "DELETE" }
      ).then(unwrapCtlData),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ctl-admin", "dianshi-records"] });
    },
  });
}
