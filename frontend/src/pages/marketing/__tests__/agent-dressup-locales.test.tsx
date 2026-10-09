import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LocaleOverrideProvider, type I18nLocale } from "@/i18n/t";
import { ensureLocaleDictionary } from "@/i18n";
import { DEFAULT_HERMES_APPEARANCE } from "@/lib/hermes-appearance";
import { HermesStepDressup } from "../agent-dressup-studio";

afterEach(cleanup);
describe("Dressup route languages", () => {
  it.each([
    ["zh-CN", "先选个颜色", "薄荷", "选个形状"],
    ["zh-Hant", "先選個顏色", "薄荷", "選個形狀"],
    ["en-US", "Pick a color first", "Mint", "Pick a shape"],
    ["id-ID", "Pilih warna dulu", "Mint", "Pilih bentuk"],
    ["es", "Elige un color primero", "Menta", "Elige una forma"],
    ["ja-JP", "まず色を選ぶ", "ミント", "形を選ぶ"],
    ["ko-KR", "먼저 색상 선택", "민트", "모양 선택"],
  ])("uses %s for headings and selectable colors", async (locale, heading, mint, shape) => {
    await ensureLocaleDictionary(locale as I18nLocale);
    render(<LocaleOverrideProvider locale={locale as I18nLocale}><HermesStepDressup appearance={DEFAULT_HERMES_APPEARANCE} onChange={() => {}} zh={locale.startsWith("zh")} /></LocaleOverrideProvider>);
    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: mint }));
    expect(screen.getByRole("heading", { name: shape })).toBeInTheDocument();
  });
});
