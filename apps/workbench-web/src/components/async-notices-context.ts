import { createContext, useContext } from "react";
import type { OperationNotice } from "./notice-history";

export interface AsyncNotices {
  loading(notice: OperationNotice): void;
  info(notice: OperationNotice): void;
  success(notice: OperationNotice): void;
  warning(notice: OperationNotice): void;
  error(notice: OperationNotice): void;
  dismiss(key: string): void;
  dismissAll(): void;
}

/** Consumers observe the notification port without importing its presentation. */
export const AsyncNoticesContext = createContext<AsyncNotices | null>(null);

export function useOptionalAsyncNotices(): AsyncNotices | null {
  return useContext(AsyncNoticesContext);
}

export function useAsyncNotices(): AsyncNotices {
  const notices = useOptionalAsyncNotices();
  if (!notices) throw new Error("Async notices require the Workbench notification provider");
  return notices;
}
