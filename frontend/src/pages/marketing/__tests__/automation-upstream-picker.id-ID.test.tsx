import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import idID from "@/i18n/generated/id-ID.json";
import zhToKey from "@/i18n/generated/zh-to-key.json";
import { LocaleOverrideProvider } from "@/i18n/t";
import { AutomationUpstreamPicker } from "../automation-upstream-picker";

const UPSTREAM_CONTEXT_COPY = [
  "正在检测上游任务能力...",
  "当前 Hermes 版本不支持上游任务，请升级后重试。",
  "暂时无法确认 Hermes 是否支持上游任务。",
  "当前任务配置了多个上游，暂不支持在 LightVela 中编辑",
  "上游任务",
  "上游任务已不可用",
  "本任务执行时，将使用上游任务最近的输出作为上下文",
  "搜索上游任务",
  "可选上游任务",
  "暂无可关联的上游任务",
  "没有匹配的上游任务",
  "暂时无法确认最新依赖关系，请重试",
  "任务依赖关系已变化，请确认最新受影响任务后再次删除",
  "当前关联上游",
  "来自：{{name}}",
  "来自：上游任务已不可用",
  "本任务执行时，将使用上游任务最近一次的输出作为上下文。",
  "（已暂停）",
  "状态",
  "正常",
  "最近完成时间",
  "最近完成状态为失败，Hermes 不会回退到更早的成功输出",
  "任务已暂停，但仍可能使用最近一次完成输出",
  "暂无完成记录，下游任务会在无上游上下文的情况下继续执行",
  "受影响的直接下游任务",
  "删除后将解除上游绑定并继续独立执行",
  "暂时无法刷新上游任务，请重试",
  "所选上游任务已删除或过期，请重新选择或解除关联",
  "所选上游任务已暂停，请重新选择或解除关联",
  "所选上游任务会形成循环，请重新选择或解除关联",
] as const;

afterEach(() => {
  cleanup();
});

describe("AutomationUpstreamPicker Indonesian localization", () => {
  it("renders the capability state and picker controls in Indonesian", async () => {
    const user = userEvent.setup();
    const { rerender } = renderPicker("loading");

    expect(screen.getByText("Memeriksa dukungan tugas upstream...")).toBeInTheDocument();

    rerender(renderPickerElement("supported"));
    const trigger = screen.getByRole("combobox", { name: "Tugas upstream" });
    expect(trigger).toHaveTextContent(
      "Saat tugas ini berjalan, output terbaru dari tugas upstream akan digunakan sebagai konteks",
    );

    await user.click(trigger);
    expect(screen.getByRole("combobox", { name: "Cari tugas upstream" })).toBeInTheDocument();
    expect(screen.getByText("Tidak ada tugas upstream yang dapat ditautkan")).toBeInTheDocument();
  });

  it.each(UPSTREAM_CONTEXT_COPY)("provides non-empty Indonesian copy for %s", (source) => {
    const key = (zhToKey as Record<string, string>)[source];

    expect(key).toBeTruthy();
    expect((idID as Record<string, string>)[key!]).toMatch(/\S/);
  });
});

function renderPicker(state: "loading" | "supported") {
  return render(renderPickerElement(state));
}

function renderPickerElement(state: "loading" | "supported") {
  return (
    <LocaleOverrideProvider locale="id-ID">
      <AutomationUpstreamPicker
        value=""
        options={[]}
        state={state}
        onChange={() => undefined}
      />
    </LocaleOverrideProvider>
  );
}
