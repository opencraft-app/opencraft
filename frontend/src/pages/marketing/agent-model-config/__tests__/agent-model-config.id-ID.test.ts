import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import idID from "@/i18n/generated/id-ID.json";
import zhToKey from "@/i18n/generated/zh-to-key.json";
import { LocaleOverrideProvider } from "@/i18n/t";
import { AgentModelConfigPanel } from "../agent-model-config-panel";
import {
  HERMES_MODEL_CONFIG_JSON_END,
  HERMES_MODEL_CONFIG_JSON_START,
} from "../hermes-model-config-command";

const MODEL_CONFIG_COPY = [
  "主模型",
  "取消备用",
  "主模型不能同时设为备用模型。",
  "失败原因",
  "未检测到可用模型",
  "选择用途",
  "设为主模型",
  "模型可用性检测未通过",
  "未能确认当前凭据可以访问该模型，请检查配置后重试。",
  "模型已添加",
  "设为备用模型",
  "未启用",
  "获取中...",
  "主模型不能同时设为备用模型",
  "Provider 名称",
  "添加模型",
  "共 {{count}} 个",
  "模型配置方式",
  "请先获取可用模型",
  "选择一个主模型，并可设置多个备用模型。配置将在新会话中生效。",
  "已获取可用模型",
  "模型可用性检测通过",
  "当前凭据可以访问该模型。",
  "添加第一个模型",
  "备用模型",
  "选择 Provider 并探测可用模型后即可添加。",
  "删除模型",
  "暂未配置模型",
  "仅添加",
  "模型配置操作失败，请重试。",
  "请选择 Provider",
  "获取可用模型",
  "请先切换主模型后再删除",
  "当前模型已经是主模型",
  "正在读取模型配置",
  "删除后将移除此模型配置；如果 Provider 下没有其他模型，也会移除对应凭据。",
  "读取模型配置失败",
] as const;

describe("Agent model configuration Indonesian localization", () => {
  afterEach(() => cleanup());

  it("renders the model configuration empty state in Indonesian", async () => {
    const execDebugCommand = vi.fn(async () => ({
      status: "Succeeded",
      exitCode: 0,
      output: [
        HERMES_MODEL_CONFIG_JSON_START,
        JSON.stringify({
          ok: true,
          snapshot: { primary: null, fallbacks: [], configuredModels: [] },
        }),
        HERMES_MODEL_CONFIG_JSON_END,
      ].join("\n"),
    }));

    render(createElement(
      LocaleOverrideProvider,
      {
        locale: "id-ID",
        children: createElement(AgentModelConfigPanel, { botId: "bot-id", execDebugCommand, providers: [] }),
      },
    ));

    expect(await screen.findByText("Belum ada model yang dikonfigurasi")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tambahkan model pertama" })).toBeInTheDocument();
  });

  it.each(MODEL_CONFIG_COPY)("provides non-empty Indonesian copy for %s", (source) => {
    const key = (zhToKey as Record<string, string>)[source];

    expect(key).toBeTruthy();
    expect((idID as Record<string, string>)[key!]).toMatch(/\S/);
  });
});
