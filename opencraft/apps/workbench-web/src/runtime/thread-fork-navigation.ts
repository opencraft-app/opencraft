import { AppServerClientError } from "@opencraft/appserver-client";

/** A catalog refresh is not a prerequisite for opening an acknowledged fork. */
export async function forkAndOpenThread(input: {
  readonly routeScopeId: () => string | null;
  readonly fork: () => Promise<string>;
  readonly refreshThreads: () => Promise<unknown>;
  readonly openThread: (threadId: string) => Promise<unknown>;
}): Promise<void> {
  const origin = input.routeScopeId();
  let childId: string;
  try {
    childId = await input.fork();
  } catch (error) {
    if (error instanceof AppServerClientError && (error.code === "TRANSPORT_ERROR" || error.code === "TIMEOUT")) {
      throw new Error("分支请求未获确认，可能已经创建；请勿立即重试。重新连接后检查会话，列表未出现也不能证明创建失败。", { cause: error });
    }
    throw error;
  }
  void input.refreshThreads().catch(() => undefined);
  if (input.routeScopeId() === origin) await input.openThread(childId);
}
