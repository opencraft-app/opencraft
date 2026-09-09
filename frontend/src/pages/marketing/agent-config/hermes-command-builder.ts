import { normalizeHermesApi } from "./utils/hermes-parsers";

const ACLI_INSTALL_SCRIPT_URL = "https://acli-1325194254.cos.accelerate.myqcloud.com/acli/install.sh";

export type HermesAcliProduct = "lighthouse" | "lightvela";

export interface HermesProviderSaveConfig {
  name: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  models: Array<{ id: string; name: string }>;
}

export interface HermesModelProbeConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  api: string;
}

export interface HermesQrUrlConfig {
  platform: string;
  isI18n?: boolean;
  acliProduct?: HermesAcliProduct;
  bindId?: string;
  ip?: string;
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

const getProductDisplayName = (product: HermesAcliProduct = "lightvela") => (
  product === "lighthouse" ? "Lighthouse" : "LightVela"
);

const getFeishuGreeting = (isI18n: boolean, product: HermesAcliProduct) => (
  isI18n
    ? `Hi, I'm the bot you just created with ${getProductDisplayName(product)}. You can chat with me now!`
    : `Hi，我是你刚刚使用${getProductDisplayName(product)}创建的机器人，你现在可以跟我聊天了！`
);

export function getHermesBootstrapAcliCommand(product: HermesAcliProduct = "lighthouse"): string {
  const safeProduct = product === "lightvela" ? "lightvela" : "lighthouse";
  return (
    "flock -w 300 /var/lock/acli-update.lock bash -c '" +
    "/usr/local/bin/acli version >/dev/null 2>&1 && " +
    "/usr/local/bin/acli self-update >/tmp/acli-self-update.log 2>&1 || " +
    `curl -fsSL ${ACLI_INSTALL_SCRIPT_URL} | ACLI_PRODUCT=${safeProduct} bash >/tmp/acli-install.log 2>&1; ` +
    "/usr/local/bin/acli version >/dev/null 2>&1 && echo \"__ACLI_OK__\" || echo \"__ACLI_MISSING__\"; " +
    "exit 0' || echo \"__ACLI_LOCK_TIMEOUT__\""
  );
}

export function createHermesCommandBuilder() {
  const channelConnect = (platform: string, arguments_: string[]) => (
    ["acli channel connect", `--platform ${platform}`, ...arguments_].join(" ")
  );

  const model = {
    getProviderSaveCommand(params: HermesProviderSaveConfig) {
      return [
        "acli provider save",
        `--name ${shellQuote(params.name)}`,
        `--base-url ${shellQuote(params.baseUrl)}`,
        `--api ${shellQuote(normalizeHermesApi(params.api))}`,
        `--api-key ${shellQuote(params.apiKey)}`,
        `--models-json ${shellQuote(JSON.stringify(params.models ?? []))}`,
      ].join(" ");
    },
    getModelSwitchCommand(modelFullId: string) {
      return `acli model switch --model ${shellQuote(modelFullId)}`;
    },
    getModelProbeCommand(params?: HermesModelProbeConfig) {
      if (!params) return "acli model probe";
      return [
        "acli model probe",
        `--provider ${shellQuote(params.provider)}`,
        `--model ${shellQuote(params.model)}`,
        `--base-url ${shellQuote(params.baseUrl)}`,
        `--api-key ${shellQuote(params.apiKey)}`,
        `--api ${shellQuote(params.api)}`,
      ].join(" ");
    },
    getListCommand() {
      return "acli provider list";
    },
    getDeleteCommand(params: { providerName: string }) {
      return `acli provider delete --name ${shellQuote(params.providerName)}`;
    },
  };

  const channel = {
    getListCommand() {
      return "acli channel status";
    },
    getQQBotConfigCommand(params: { appId: string; clientSecret: string }) {
      return [
        "acli configure gateway qqbot",
        `--app-id ${shellQuote(params.appId)}`,
        `--client-secret ${shellQuote(params.clientSecret)}`,
      ].join(" ");
    },
    getWecomConfigCommand(params: { appId: string; clientSecret: string }) {
      return [
        "acli configure gateway wecom",
        `--app-id ${shellQuote(params.appId)}`,
        `--client-secret ${shellQuote(params.clientSecret)}`,
      ].join(" ");
    },
    getYuanbaoConfigCommand(params: { appKey: string; appSecret: string }) {
      return [
        "acli configure gateway yuanbao",
        `--app-key ${shellQuote(params.appKey)}`,
        `--app-secret ${shellQuote(params.appSecret)}`,
      ].join(" ");
    },
    getChannelConnectCommand(platform: string, token: string) {
      return channelConnect(platform, [`--app-secret ${shellQuote(token)}`]);
    },
    getTelegramConfigCommand(params: { botToken: string }) {
      return channelConnect("telegram", [`--app-secret ${shellQuote(params.botToken)}`]);
    },
    getDiscordConfigCommand(params: { botToken: string }) {
      return channelConnect("discord", [`--app-secret ${shellQuote(params.botToken)}`]);
    },
    getSlackConfigCommand(params: { botToken: string; appToken: string }) {
      return channelConnect("slack", [
        `--bottoken ${shellQuote(params.botToken)}`,
        `--apptoken ${shellQuote(params.appToken)}`,
      ]);
    },
    getDingtalkConfigCommand(params: { clientId: string; clientSecret: string }) {
      return channelConnect("dingtalk", [
        `--app-id ${shellQuote(params.clientId)}`,
        `--app-secret ${shellQuote(params.clientSecret)}`,
      ]);
    },
    getQrUrlCommand(params: HermesQrUrlConfig) {
      const parts = [
        "acli gateway qr-url",
        `--platform ${params.platform}`,
        "--wait true",
      ];
      if (params.platform === "feishu") {
        const product = params.acliProduct ?? "lightvela";
        parts.push(`--greeting ${shellQuote(getFeishuGreeting(!!params.isI18n, product))}`);
      }
      if (params.platform === "yuanbao") {
        if (params.bindId) parts.push(`--bind-id ${shellQuote(params.bindId)}`);
        if (params.ip) parts.push(`--ip ${shellQuote(params.ip)}`);
      }
      return parts.join(" ");
    },
    getDeleteCommand(platform: string) {
      return `acli channel delete --platform ${shellQuote(platform)}`;
    },
  };

  const gateway = {
    getRuntimeCheckCommand: () => "acli backend runtime-check",
    getStatusCommand: () => "acli gateway status",
    getRestartCommand: () => "acli gateway restart",
    getBootstrapCommand: getHermesBootstrapAcliCommand,
  };

  return { model, channel, gateway };
}

export type HermesCommandBuilder = ReturnType<typeof createHermesCommandBuilder>;

export interface AgentScriptCommands {
  hermes: HermesCommandBuilder;
  openclaw: {
    gateway: { STATUS_COMMAND: string; RESTART_COMMAND: string };
    config: { GET_OPENCLAW_CONFIG_COMMAND: string };
    channel: { GET_WEIXIN_ACCOUNTS_COMMAND: string };
  };
}

export function createAgentScriptCommands(): AgentScriptCommands {
  return {
    hermes: createHermesCommandBuilder(),
    openclaw: {
      gateway: {
        STATUS_COMMAND: "acli gateway status",
        RESTART_COMMAND: "acli gateway restart",
      },
      config: {
        GET_OPENCLAW_CONFIG_COMMAND: "acli config get --section models,channels,gateway,agents",
      },
      channel: {
        GET_WEIXIN_ACCOUNTS_COMMAND: "acli channel status --platform weixin",
      },
    },
  };
}
