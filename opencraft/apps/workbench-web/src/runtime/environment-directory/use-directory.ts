import { useSyncExternalStore } from "react";
import type { EnvironmentDirectory, EnvironmentDirectorySnapshot } from "@opencraft/workbench-runtime";
const empty: EnvironmentDirectorySnapshot = {revision: 0, entries: [], sources: []};
const readEmpty = () => empty;
const subscribeEmpty = () => () => {};
export function useEnvironmentDirectory(directory?: EnvironmentDirectory) {
  return useSyncExternalStore(directory?.subscribe ?? subscribeEmpty, directory?.getSnapshot ?? readEmpty, directory?.getSnapshot ?? readEmpty);
}
export function environmentLifecycleLabel(state: string) {
  return ({ready: "可用", running: "运行中", creating: "创建中", pending: "等待创建", starting: "启动中", stopping: "停止中", stopped: "已停止", paused: "已暂停", failed: "异常", deleting: "删除中", isolated: "已隔离", disabled: "未启用"} as Record<string,string>)[state] ?? "状态未知";
}
