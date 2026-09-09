/**
 * Direct migration of createHermesChannelCommands from
 * @tencent/tea-sdk-lightclaw 1.12.1. Only static TypeScript parameter types
 * were added; command spelling, quoting, defaults and branching are unchanged.
 */

function escapeSingleQuote(input: string): string {
  return String(input).replace(/'/g, `'\\''`);
}

const DEFAULT_HERMES_ACLI_PRODUCT = "lightvela";
const ACLI_PRODUCT_DISPLAY_NAME = {
  lighthouse: "Lighthouse",
  lightvela: "LightVela",
} as const;
type AcliProduct = keyof typeof ACLI_PRODUCT_DISPLAY_NAME;
const getAcliProductDisplayName = (product: AcliProduct = DEFAULT_HERMES_ACLI_PRODUCT) => ACLI_PRODUCT_DISPLAY_NAME[product];
const getFeishuGreetingZh = (product: AcliProduct = DEFAULT_HERMES_ACLI_PRODUCT) => `Hi，我是你刚刚使用${getAcliProductDisplayName(product)}创建的机器人，你现在可以跟我聊天了！`;
const getFeishuGreetingEn = (product: AcliProduct = DEFAULT_HERMES_ACLI_PRODUCT) => `Hi, I'm the bot you just created with ${getAcliProductDisplayName(product)}. You can chat with me now!`;

export type HermesQrPlatform = "weixin" | "feishu" | "qqbot" | "whatsapp" | "yuanbao" | "dingtalk";

export function createHermesChannelCommands() {
  return {
    getListCommand() {
      return "acli channel status";
    },
    getQQBotConfigCommand(params: { appId: string; clientSecret: string }) {
      return (`acli configure gateway qqbot `
        + `--app-id '${escapeSingleQuote(params.appId)}' `
        + `--client-secret '${escapeSingleQuote(params.clientSecret)}'`);
    },
    getWecomConfigCommand(params: { appId: string; clientSecret: string }) {
      return (`acli configure gateway wecom `
        + `--app-id '${escapeSingleQuote(params.appId)}' `
        + `--client-secret '${escapeSingleQuote(params.clientSecret)}'`);
    },
    getYuanbaoConfigCommand(params: { appKey: string; appSecret: string }) {
      return (`acli configure gateway yuanbao `
        + `--app-key '${escapeSingleQuote(params.appKey)}' `
        + `--app-secret '${escapeSingleQuote(params.appSecret)}'`);
    },
    getChannelConnectCommand(platform: string, token: string) {
      return `acli channel connect --platform ${platform} --app-secret '${escapeSingleQuote(token)}'`;
    },
    getTelegramConfigCommand(params: { botToken: string }) {
      return this.getChannelConnectCommand("telegram", params.botToken);
    },
    getDiscordConfigCommand(params: { botToken: string }) {
      return this.getChannelConnectCommand("discord", params.botToken);
    },
    getSlackConfigCommand(params: { botToken: string; appToken: string }) {
      return (`acli channel connect --platform slack `
        + `--bottoken '${escapeSingleQuote(params.botToken)}' `
        + `--apptoken '${escapeSingleQuote(params.appToken)}'`);
    },
    getDingtalkConfigCommand(params: { clientId: string; clientSecret: string }) {
      return (`acli channel connect --platform dingtalk `
        + `--app-id '${escapeSingleQuote(params.clientId)}' `
        + `--app-secret '${escapeSingleQuote(params.clientSecret)}'`);
    },
    getQrUrlCommand(params: {
      platform: HermesQrPlatform;
      isI18n?: boolean;
      acliProduct?: AcliProduct;
      bindId?: string;
      ip?: string;
    }) {
      const parts = ["acli gateway qr-url", `--platform ${params.platform}`, "--wait true"];
      if (params.platform === "feishu") {
        const product = params.acliProduct || DEFAULT_HERMES_ACLI_PRODUCT;
        const greeting = params.isI18n ? getFeishuGreetingEn(product) : getFeishuGreetingZh(product);
        parts.push(`--greeting '${escapeSingleQuote(greeting)}'`);
      }
      if (params.platform === "yuanbao") {
        if (params.bindId) parts.push(`--bind-id '${escapeSingleQuote(params.bindId)}'`);
        if (params.ip) parts.push(`--ip '${escapeSingleQuote(params.ip)}'`);
      }
      return parts.join(" ");
    },
    getDeleteCommand(platform: string) {
      return `acli channel delete --platform '${escapeSingleQuote(platform)}'`;
    },
  };
}
