import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";

export type CtlBotStatus =
  | "Creating"
  | "Running"
  | "Paused"
  | "Failed"
  | "Deleting"
  | "Deleted";

export interface CtlBot {
  instance_id: string;
  user_id: string;
  sandbox_id?: string;
  status: CtlBotStatus;
  created_at: string;
  updated_at: string;
  timeout_at?: string;
  born_date_for_china?: string;
  born_number_for_china?: number;
}

export interface CtlBotListResponse {
  total: number;
  page: number;
  page_size: number;
  items: CtlBot[];
}

export interface CtlBotFilters {
  page: number;
  pageSize: number;
  userID?: string;
  status?: string;
}

export function useCtlBots(filters: CtlBotFilters) {
  return useQuery({
    queryKey: ["ctl-bots", filters],
    queryFn: () =>
      apiClient<CtlBotListResponse>("ctl/bots", {
        params: {
          page: filters.page,
          page_size: filters.pageSize,
          user_id: filters.userID || undefined,
          status: filters.status || undefined,
        },
      }),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}

export function useDeleteCtlBot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (instanceID: string) =>
      apiClient(`ctl/bots/${encodeURIComponent(instanceID)}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ctl-bots"] });
    },
  });
}
