/**
 * LightClaw Scripts SDK - TAT API 封装
 *
 * 基于 @tencent/iaas-workbench-api-client 的 apiRequest 封装 TAT 云 API。
 *
 * ## 为什么 apiRequest 采用懒加载？
 *
 * `@tencent/iaas-workbench-api-client/lib/region.js` 在模块顶层
 * **立即执行** `initRegionIdMap()`，会同步向 `workbench.cloud.tencent.com`
 * 发起 `DescribeRegionsAndZones` 请求。对于不在腾讯云控制台 iframe 环境
 * 下的消费方（如 mono/frontend 的 Vite dev server），该请求必然：
 *   1) 触发 CORS 跨域错误（preflight 失败）
 *   2) 没有腾讯云会话 cookie 导致 401
 *
 * 消费方如果通过 `IProductConfig.runCommand` / `.getInvocationTask`
 * 自定义命令通道（例如走自家后端的 TAT 代理），本模块内的函数就
 * **不会**被调用，理想状态是连这个包都不要加载。
 *
 * 因此：
 *   - 顶层 `import { apiRequest }` → 改为 `import type` 或动态 import
 *   - 仅在真正的 `tatCapiRequest` / `lhCapiRequest` 调用时才 `await import()`
 *   - 打包工具（Vite / webpack）会把该包单独切成 chunk，按需加载
 *
 * ## mono2/frontend 迁移说明
 *
 * 原 SDK 顶层 `import { app } from '@tencent/tea-app'` 用于 `app.sdk.use('cam-sdk')`
 * 显示 CAM 鉴权错误弹窗。mono2/frontend 未引入 `@tencent/tea-app`，此处改为
 * 动态 import + 运行时降级：仅在 CAPI 请求失败（onCamError）时才尝试加载，
 * 加载失败则 console.error 兜底，不阻断主流程。
 *
 * 实际场景：frontend 通过 `commandAdapter` 走自家后端代理，不直接调云 API，
 * 这段 onCamError 回调理论上不会被触发。
 */

/**
 * 懒加载 `@tencent/iaas-workbench-api-client` 的 `apiRequest`。
 *
 * 只在第一次调用时动态 import 该包，触发其内部 `region.js` 的
 * `initRegionIdMap()`。没有消费到云 API 的场景下这个包永远不会被加载。
 *
 * mono2/frontend 未安装 `@tencent/iaas-workbench-api-client`。
 * 使用 `new Function(...)` + 模板字符串拼接包名，绕过 webpack/turbopack
 * 静态模块图分析（否则 Next build 会因 "Can't resolve" 失败）。
 * 实际场景：frontend 通过 commandAdapter 走自家后端代理，不直接调云 API。
 */
let cachedApiRequestPromise: Promise<(...args: any[]) => Promise<any>> | null = null;
function getApiRequest(): Promise<(...args: any[]) => Promise<any>> {
  if (!cachedApiRequestPromise) {
    // 动态 import 包名：用字符串拼接阻止打包器静态分析
    const moduleName = '@tencent/' + 'iaas-workbench-api-client';
    const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<any>;
    cachedApiRequestPromise = dynamicImport(moduleName)
      .then((mod) => (mod as any).apiRequest)
      .catch((err) => {
        // 包未安装 → 不阻断，返回永远 pending 的 promise（调用方超时）
        console.warn(
          '[tea-sdk-internal/model] @tencent/iaas-workbench-api-client not available, cloud API calls will hang:',
          err,
        );
        return new Promise(() => {});
      });
  }
  return cachedApiRequestPromise;
}

/**
 * 懒加载 `@tencent/tea-app` 的 `app`（仅用于 CAM 鉴权错误弹窗）。
 *
 * mono2/frontend 未安装 `@tencent/tea-app`。同 getApiRequest()，使用
 * `new Function(...)` 绕过打包器静态分析。失败时 console.warn 兜底，
 * 不阻断主流程。原 SDK 在 tea-app 可用时会弹出 CAM break modal。
 */
async function showCamBreakModal(message: string): Promise<void> {
  try {
    const moduleName = '@tencent/' + 'tea-app';
    const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<any>;
    const teaApp = await dynamicImport(moduleName);
    const cam = await (teaApp as any).app?.sdk?.use?.('cam-sdk');
    cam?.showBreakModal?.({ message });
  } catch (err) {
    console.warn('[tea-sdk-internal/model] CAM break modal unavailable (tea-app not installed):', message, err);
  }
}

/** 请求配置选项 */
interface IRequestOpts {
  camTips?: boolean;
  tipErr?: boolean;
  [key: string]: any;
}

/**
 * TAT 云 API 请求封装
 */
export async function tatCapiRequest<T = any>(
  { action, data = {}, regionId }: { action: string; data?: Record<string, any>; regionId: number },
  options?: IRequestOpts,
): Promise<T> {
  const apiRequest = await getApiRequest();
  return apiRequest(
    {
      serviceType: 'tat',
      action,
      data: {
        Version: '2020-10-28',
        ...data,
      },
      regionId,
    },
    {
      onCamError: async (error: any) => {
        if (options.camTips !== false) {
          await showCamBreakModal(error.message);
        }
      },
      ...(options || {}),
    },
  ).then(({ Response = {} }: any) => Response);
}

/** RunCommand 请求参数 */
export interface IRunCommandParams {
  RegionId: number;
  InstanceIds: string[];
  SaveCommand: boolean;
  CommandType: string;
  Content: string;
  Timeout: number;
  /**
   * 以指定用户名执行命令（TAT RunCommand 的 Username 字段）
   * 不传则以镜像默认用户执行（通常 root）。Hermes 镜像传 'agentuser'。
   */
  Username?: string;
}

/** 执行任务结果 */
export interface IInvocationTask {
  TaskStatus?: string;
  TaskResult?: {
    Output?: string;
  };
}

/** 轮询任务的可选配置 */
export interface IPollingOptions {
  /** 进度回调，每次轮询时传入当前的 base64 编码输出 */
  onProgress?: (output: string) => void;
  /** 最大轮询次数，不传则不限 */
  maxRetries?: number;
}

/**
 * 执行命令 (TAT RunCommand)
 */
export async function RunCommand(data: IRunCommandParams, options?: IRequestOpts): Promise<{ InvocationId?: string }> {
  const { RegionId: regionId, ...restParams } = data;
  return tatCapiRequest(
    { action: 'RunCommand', data: restParams, regionId },
    {
      camTips: true,
      ...options,
    },
  );
}

/**
 * 查询执行任务 (TAT DescribeInvocationTasks)
 */

export async function DescribeInvocationTasks(
  data: {
    RegionId: number;
    InvocationTaskIds?: string[];
    Filters?: { Name: string; Values: string[] }[];
    Limit?: number;
    Offset?: number;
    HideOutput?: boolean;
  },
  options?: IRequestOpts,
): Promise<{ InvocationTaskSet?: any[] }> {
  const { RegionId: regionId, ...restParams } = data;
  return tatCapiRequest(
    { action: 'DescribeInvocationTasks', data: restParams, regionId },
    {
      camTips: true,
      ...options,
    },
  );
}

/** 任务进行中的状态集合 */
const PENDING_STATUSES = ['PENDING', 'DELIVERING', 'RUNNING'];

/**
 * 获取执行任务结果（自动轮询直到任务完成）
 *
 * - 不传 options：普通模式，轮询直到完成，无次数限制
 * - 传 onProgress：流式模式，每次轮询回调当前输出，受 maxRetries 限制
 *
 * @param regionId 地域 ID
 * @param invocationId 执行 ID
 * @param options 可选轮询配置
 */
export async function getInvocationTask(
  regionId: number,
  invocationId?: string,
  options?: IPollingOptions,
): Promise<IInvocationTask> {
  const { onProgress, maxRetries } = options ?? {};
  let retries = 0;

  const poll = async (): Promise<IInvocationTask> => {
    const res = await DescribeInvocationTasks({
      RegionId: regionId,
      Filters: [{ Name: 'invocation-id', Values: [invocationId] }],
      HideOutput: false,
    });

    const task = res?.InvocationTaskSet?.[0] ?? {};

    if (onProgress && task?.TaskResult?.Output) {
      onProgress(task.TaskResult.Output);
    }

    if (PENDING_STATUSES.includes(task?.TaskStatus)) {
      retries += 1;
      if (maxRetries && retries >= maxRetries) return task;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return poll();
    }

    return task;
  };

  return poll();
}

// ============================================================
// Lighthouse CAPI 请求封装（从 tea-app-lighthouse 迁移）
// ============================================================

/**
 * Lighthouse 云 API 请求封装
 */
export async function lhCapiRequest<T = any>(
  { action, data = {}, regionId }: { action: string; data?: Record<string, any>; regionId: number },
  options?: IRequestOpts,
): Promise<T> {
  const apiRequest = await getApiRequest();
  return apiRequest(
    {
      serviceType: 'lighthouse',
      action,
      data: {
        Version: '2020-03-24',
        ...data,
      },
      regionId,
    },
    {
      onCamError: async (error: any) => {
        if (options?.camTips !== false) {
          await showCamBreakModal(error.message);
        }
      },
      ...(options || {}),
    },
  ).then(({ Response = {} }: any) => Response);
}

/** 防火墙规则类型 */
interface IFirewallRule {
  Protocol: string;
  Port: string;
  CidrBlock: string;
  Action: string;
  FirewallRuleDescription?: string;
}

interface IFirewallRuleInfo extends IFirewallRule {
  [key: string]: any;
}

/** 查询防火墙规则 */
export async function DescribeFirewallRules(
  params: { InstanceId: string; Offset: number; Limit?: number },
  regionId: number,
  opts?: IRequestOpts,
): Promise<{
  TotalCount: number;
  FirewallRuleSet: IFirewallRuleInfo[];
  FirewallVersion: number;
  RequestId: string;
}> {
  return lhCapiRequest({ action: 'DescribeFirewallRules', data: params, regionId }, opts);
}

/** 添加防火墙规则 */
export async function CreateFirewallRules(
  params: { InstanceId: string; FirewallRules: IFirewallRule[]; FirewallVersion: number },
  regionId: number,
  opts?: IRequestOpts,
): Promise<{ RequestId: string }> {
  return lhCapiRequest({ action: 'CreateFirewallRules', data: params, regionId }, opts);
}
