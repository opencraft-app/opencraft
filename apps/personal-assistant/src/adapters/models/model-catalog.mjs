import { compatibleProvider } from "./openai-compatible.mjs";
import { setTimeout as delay } from "node:timers/promises";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { digest } from "../../domain/values.mjs";

export async function modelsFor(profile) {
  const models = createModels();
  if (profile.config.mode === "fixture") return { mode: "fixture" };
  const { provider, modelId } = profile.config.model ?? {};
  const factories = {
    "openai-compatible": async () => compatibleProvider(profile.config.model),
    deepseek: async () =>
      (
        await import("@earendil-works/pi-ai/providers/deepseek")
      ).deepseekProvider(),
    anthropic: async () =>
      (
        await import("@earendil-works/pi-ai/providers/anthropic")
      ).anthropicProvider(),
  };
  if (!factories[provider] || !modelId)
    throw new Error(
      "model.provider must be deepseek/anthropic/openai-compatible and model.modelId must be explicit",
    );
  models.setProvider(await factories[provider]());
  if (!models.getModel(provider, modelId))
    throw new Error("Model not present in the pinned Pi provider catalog");
  return { mode: "model", models, model: { provider, modelId } };
}

export function fixtureModels(profile, executionId) {
  const models = createModels(),
    faux = fauxProvider({ tokensPerSecond: 100000 });
  const response = async (transcript, options) => {
    await delay(profile.config.fixtureDelayMs, undefined, {
      signal: options?.signal,
    });
    const start = transcript.messages.findLastIndex((m) => m.role === "user");
    const user = transcript.messages[start];
    const raw =
      typeof user?.content === "string"
        ? user.content
        : user?.content
            ?.filter((v) => v.type === "text")
            .map((v) => v.text)
            .join("");
    const input = JSON.parse(raw);
    const userAnswer = transcript.messages
      .slice(start + 1)
      .find(
        (m) =>
          m.role === "toolResult" &&
          ["ask_user", "request_intervention"].includes(m.toolName),
      );
    const interventionKind = /\[wait:(secret|authorization|handoff)\]/.exec(
      input.text,
    )?.[1];
    if (
      interventionKind &&
      !userAnswer &&
      input.delegation?.tools?.includes("request_intervention")
    )
      return fauxAssistantMessage(
        [
          fauxToolCall(
            "request_intervention",
            {
              kind: interventionKind,
              question: "请通过专用输入通路完成这项介入",
              provider: "test-service",
            },
            { id: `intervention-${digest(executionId).slice(0, 20)}` },
          ),
        ],
        { stopReason: "toolUse" },
      );
    if (
      input.text.includes("先问我") &&
      !userAnswer &&
      input.delegation?.tools?.includes("ask_user")
    )
      return fauxAssistantMessage(
        [
          fauxToolCall(
            "ask_user",
            {
              question: "本次整理需要聚焦哪个范围？",
              ...(input.text.includes("[choice]")
                ? {
                    choices: [
                      { label: "本周", value: "week" },
                      { label: "本月", value: "month" },
                    ],
                    allowCustom: false,
                  }
                : {}),
            },
            { id: `question-${digest(executionId).slice(0, 20)}` },
          ),
        ],
        { stopReason: "toolUse" },
      );
    const skill = input.skills?.find((s) =>
      input.text.includes(`[skill:${s.id}]`),
    );
    const loadedSkill = transcript.messages
      .slice(start + 1)
      .find((m) => m.role === "toolResult" && m.toolName === "load_skill");
    if (skill && !loadedSkill)
      return fauxAssistantMessage(
        [fauxToolCall("load_skill", { skillId: skill.id })],
        { stopReason: "toolUse" },
      );
    const result = transcript.messages
      .slice(start + 1)
      .find((m) => m.role === "toolResult" && m.toolName === "publish_note");
    if (result) {
      if (result.isError)
        return fauxAssistantMessage(
          "Fixture could not publish the note; the work remains blocked.",
        );
      return fauxAssistantMessage(
        `【确定性测试模型】已处理：${input.text}\n${result.content
          .filter((v) => v.type === "text")
          .map((v) => v.text)
          .join("\n")}`,
      );
    }
    const listed = transcript.messages
      .slice(start + 1)
      .find((m) => m.role === "toolResult" && m.toolName === "list_materials");
    const read = transcript.messages
      .slice(start + 1)
      .find((m) => m.role === "toolResult" && m.toolName === "read_material");
    const toolText = (m) =>
      m.content
        .filter((v) => v.type === "text")
        .map((v) => v.text)
        .join("");
    if (input.delegation?.resources?.length && !listed)
      return fauxAssistantMessage(
        [fauxToolCall("list_materials", { directory: "" })],
        { stopReason: "toolUse" },
      );
    const files =
      listed && !listed.isError ? JSON.parse(toolText(listed)).files : [];
    const first = files.find((f) => f.type === "file");
    if (first && !read)
      return fauxAssistantMessage(
        [fauxToolCall("read_material", { path: first.path })],
        { stopReason: "toolUse" },
      );
    const evidence = read && !read.isError ? JSON.parse(toolText(read)) : null;
    if (
      input.completion?.output === "text" &&
      !input.completion.checks.some((c) =>
        ["note_published", "note_contains"].includes(c.kind),
      )
    )
      return fauxAssistantMessage(
        `【确定性文本结果】${input.text}${evidence ? `\n来源：${evidence.path}\n${evidence.text}` : ""}`,
      );
    return fauxAssistantMessage(
      [
        fauxToolCall(
          "publish_note",
          {
            body: `# Runner 验证产物\n\n${input.text}\n\n记忆快照：${JSON.stringify(input.memories)}\n${loadedSkill && !loadedSkill.isError ? `技能方法：${JSON.stringify(loadedSkill.content)}\n` : ""}\n${userAnswer && !userAnswer.isError ? `用户补充：${toolText(userAnswer)}\n` : ""}${evidence ? `\n资料来源：${evidence.path}\nSHA256：${evidence.sha256}\n\n${evidence.text}` : ""}`,
          },
          { id: `note-${digest(executionId).slice(0, 20)}` },
        ),
      ],
      { stopReason: "toolUse" },
    );
  };
  faux.setResponses(Array(100).fill(response));
  models.setProvider(faux.provider);
  return { models, model: { provider: "faux", modelId: "faux-1" } };
}

export class ModelCatalog {
  static async open(profile) {
    return new ModelCatalog(profile, await modelsFor(profile));
  }
  constructor(profile, configured) {
    this.profile = profile;
    this.configured = configured;
  }
  forExecution(id) {
    return this.configured.mode === "fixture"
      ? fixtureModels(this.profile, id)
      : this.configured;
  }
}
