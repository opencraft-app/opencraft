/**
 * 七彩石配置拉取
 *
 * 通过宿主控制台的 rainbow 代理接口拉取七彩石配置（KV 型）。
 * 域名按站点（国内/国际）区分：
 *  - 国内：https://dnspod.cloud.tencent.com/ajax/rainbow
 *  - 国际：https://www.dnspod.com/ajax/rainbow
 *
 * 消费方（mono2）若代理域名不同，可通过 `baseUrl` 覆盖。
 */

/** rainbow 代理域名（含 path） */
const RAINBOW_ENDPOINT = {
  domestic: 'https://dnspod.cloud.tencent.com/ajax/rainbow?action=getRainbowConfig',
  oversea: 'https://www.dnspod.com/ajax/rainbow?action=getRainbowConfig',
};

/** 七彩石 KV 项 */
export interface IRainbowKeyValue {
  key: string;
  value: string;
}

/** 七彩石单个 group 返回结构（仅列出用到的字段） */
export interface IRainbowGroup {
  group: string;
  version?: string;
  versionName?: string;
  rows?: unknown[];
  keyValues?: IRainbowKeyValue[];
}

/** 七彩石接口返回结构 */
export interface IRainbowResponse {
  code: number;
  data?: IRainbowGroup[];
  [key: string]: unknown;
}

/** getRainbow 请求参数 */
export interface IGetRainbowParams {
  /** 分组名称，可包含多个分组 */
  groups: string[];
  /** 对应应用名称，如 'lighthouse' */
  app: string;
  /** 环境支持，0 关闭，1 开启 */
  enableEnv: number;
  /** 是否国际站（决定请求域名），默认 false */
  isI18n?: boolean;
  /** 自定义代理完整 URL，传入则忽略 isI18n 的域名选择（供 mono2 覆盖） */
  baseUrl?: string;
}

/**
 * 获取七彩石配置
 *
 * @returns 七彩石接口返回（code === 0 视为成功）
 * @throws 请求失败、HTTP 非 2xx、或 code !== 0 时抛出
 */
export const getRainbow = async ({
  groups,
  app,
  enableEnv,
  isI18n = false,
  baseUrl,
}: IGetRainbowParams): Promise<IRainbowResponse> => {
  const url = baseUrl || (isI18n ? RAINBOW_ENDPOINT.oversea : RAINBOW_ENDPOINT.domestic);

  // 8s 超时，避免七彩石挂起导致面板长期用兜底
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ groups, app, options: { enableEnv } }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new Error(`Rainbow config request failed: HTTP ${response.status}`);
  }

  const data: IRainbowResponse = await response.json();

  if (data && data.code === 0) {
    return data;
  }

  throw new Error(`Rainbow config returned non-zero code: ${data.code}`);
};
