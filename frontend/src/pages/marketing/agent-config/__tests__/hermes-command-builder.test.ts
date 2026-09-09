import { describe, expect, it } from "vitest";

import { createHermesCommandBuilder } from "../hermes-command-builder";

describe("Hermes command builder", () => {
  it("preserves the existing profile-implicit commands", () => {
    const commands = createHermesCommandBuilder();

    expect(commands.model.getListCommand()).toBe("acli provider list");
    expect(commands.model.getModelSwitchCommand("openai/gpt-5"))
      .toBe("acli model switch --model 'openai/gpt-5'");
    expect(commands.channel.getListCommand()).toBe("acli channel status");
    expect(commands.gateway.getRestartCommand()).toBe("acli gateway restart");
  });

  it("matches the current provider and channel command format", () => {
    const commands = createHermesCommandBuilder();

    expect(commands.model.getProviderSaveCommand({
      name: "custom",
      baseUrl: "https://example.com/v1",
      api: "openai-completions",
      apiKey: "secret",
      models: [{ id: "model-1", name: "Model 1" }],
    })).toBe(
      "acli provider save --name 'custom' --base-url 'https://example.com/v1' "
      + "--api 'chat_completions' --api-key 'secret' "
      + "--models-json '[{\"id\":\"model-1\",\"name\":\"Model 1\"}]'",
    );
    expect(commands.channel.getTelegramConfigCommand({ botToken: "token" }))
      .toBe("acli channel connect --platform telegram --app-secret 'token'");
    expect(commands.channel.getQrUrlCommand({ platform: "feishu" }))
      .toBe(
        "acli gateway qr-url --platform feishu --wait true "
        + "--greeting 'Hi，我是你刚刚使用LightVela创建的机器人，你现在可以跟我聊天了！'",
      );
    expect(commands.channel.getDeleteCommand("telegram"))
      .toBe("acli channel delete --platform 'telegram'");
  });

  it("quotes command values without adding profile routing", () => {
    const commands = createHermesCommandBuilder();

    expect(commands.model.getDeleteCommand({ providerName: "a'b" }))
      .toContain("--name 'a'\\''b'");
    expect(commands.model.getDeleteCommand({ providerName: "custom" })).not.toContain("--agent");
    expect(commands.channel.getSlackConfigCommand({ botToken: "bot", appToken: "app" }))
      .not.toContain("--agent");
  });

  it("preserves every credential-based channel command", () => {
    const channel = createHermesCommandBuilder().channel;

    expect(channel.getQQBotConfigCommand({ appId: "qq-id", clientSecret: "qq-secret" }))
      .toBe("acli configure gateway qqbot --app-id 'qq-id' --client-secret 'qq-secret'");
    expect(channel.getWecomConfigCommand({ appId: "wecom-id", clientSecret: "wecom-secret" }))
      .toBe("acli configure gateway wecom --app-id 'wecom-id' --client-secret 'wecom-secret'");
    expect(channel.getYuanbaoConfigCommand({ appKey: "app-key", appSecret: "app-secret" }))
      .toBe("acli configure gateway yuanbao --app-key 'app-key' --app-secret 'app-secret'");
    expect(channel.getDiscordConfigCommand({ botToken: "discord-token" }))
      .toBe("acli channel connect --platform discord --app-secret 'discord-token'");
    expect(channel.getSlackConfigCommand({ botToken: "xoxb-token", appToken: "xapp-token" }))
      .toBe("acli channel connect --platform slack --bottoken 'xoxb-token' --apptoken 'xapp-token'");
    expect(channel.getDingtalkConfigCommand({ clientId: "client-id", clientSecret: "client-secret" }))
      .toBe("acli channel connect --platform dingtalk --app-id 'client-id' --app-secret 'client-secret'");
  });

  it("preserves model probe and gateway commands", () => {
    const commands = createHermesCommandBuilder();

    expect(commands.model.getModelProbeCommand()).toBe("acli model probe");
    expect(commands.model.getModelProbeCommand({
      provider: "custom",
      model: "model-1",
      baseUrl: "https://example.com/v1",
      apiKey: "secret",
      api: "chat_completions",
    })).toBe(
      "acli model probe --provider 'custom' --model 'model-1' "
      + "--base-url 'https://example.com/v1' --api-key 'secret' --api 'chat_completions'",
    );
    expect(commands.gateway.getRuntimeCheckCommand()).toBe("acli backend runtime-check");
    expect(commands.gateway.getStatusCommand()).toBe("acli gateway status");
  });
});
