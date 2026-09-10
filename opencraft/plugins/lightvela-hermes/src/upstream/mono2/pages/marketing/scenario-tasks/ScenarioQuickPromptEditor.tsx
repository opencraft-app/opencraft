// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react";

import { useT } from "../../../i18n/t";
import type { ScenarioQuickPromptSegment } from "./scenario-packs";

export function ScenarioQuickPromptEditor({
  value,
  onChange,
  suggestedSegments,
  footer,
}: {
  value: string;
  onChange: (value: string) => void;
  suggestedSegments: ScenarioQuickPromptSegment[];
  footer?: ReactNode;
}) {
  const t = useT();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const colorSegments = useMemo(
    () => colorizeEditedPrompt(value, suggestedSegments),
    [suggestedSegments, value],
  );

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.max(132, Math.min(textarea.scrollHeight, 320))}px`;
  }, [value]);

  return (
    <section role="group" aria-label={t("告诉你的 AI 助手")}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-black/78">{t("告诉你的 AI 助手")}</h3>
        <span className="rounded-full bg-black/[0.035] px-2 py-0.5 text-[11px] font-normal text-black/42">
          {t("已帮你写好")}
        </span>
      </div>
      <div
        data-testid="scenario-task-composer"
        className="mt-1.5 overflow-hidden rounded-lg border border-black/[0.07] bg-white shadow-[0_8px_28px_rgba(15,23,42,0.035)] transition focus-within:border-black/[0.14] focus-within:shadow-[0_10px_32px_rgba(15,23,42,0.055)]"
      >
        <div className="relative">
          <div
            ref={mirrorRef}
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-4 py-3.5 text-[15px] font-normal leading-7"
          >
            {colorSegments.map((segment, index) => (
              <span
                key={`${segment.suggested}-${index}`}
                data-suggested={segment.suggested ? "true" : "false"}
                className={segment.suggested ? "text-[#A33A3A]" : "text-black/72"}
              >
                {segment.text}
              </span>
            ))}
          </div>
          <textarea
            ref={textareaRef}
            aria-label={t("任务内容")}
            value={value}
            rows={5}
            spellCheck={false}
            onScroll={(event) => {
              if (mirrorRef.current) mirrorRef.current.scrollTop = event.currentTarget.scrollTop;
            }}
            onChange={(event) => onChange(event.target.value)}
            className="relative z-10 block min-h-[132px] max-h-80 w-full resize-none overflow-y-auto border-0 bg-transparent px-4 py-3.5 text-[15px] font-normal leading-7 text-transparent caret-[#A33A3A] outline-none selection:bg-[#A33A3A]/15 placeholder:text-black/28"
          />
        </div>
        {footer ? (
          <div className="border-t border-black/[0.045] bg-black/[0.008] px-3 py-2">
            {footer}
          </div>
        ) : null}
      </div>
    </section>
  );
}

interface ColoredPromptSegment {
  text: string;
  suggested: boolean;
}

function colorizeEditedPrompt(
  value: string,
  baselineSegments: ScenarioQuickPromptSegment[],
): ColoredPromptSegment[] {
  const baselineCharacters: string[] = [];
  const baselineSuggested: boolean[] = [];

  for (const segment of baselineSegments) {
    for (const character of Array.from(segment.text)) {
      baselineCharacters.push(character);
      baselineSuggested.push(segment.suggested);
    }
  }

  const currentCharacters = Array.from(value);
  if (baselineCharacters.length === 0) {
    return value ? [{ text: value, suggested: true }] : [];
  }

  const rowLength = currentCharacters.length + 1;
  const table = new Uint16Array((baselineCharacters.length + 1) * rowLength);

  for (let baselineIndex = 1; baselineIndex <= baselineCharacters.length; baselineIndex += 1) {
    for (let currentIndex = 1; currentIndex <= currentCharacters.length; currentIndex += 1) {
      const tableIndex = baselineIndex * rowLength + currentIndex;
      table[tableIndex] = baselineCharacters[baselineIndex - 1] === currentCharacters[currentIndex - 1]
        ? (table[(baselineIndex - 1) * rowLength + currentIndex - 1] ?? 0) + 1
        : Math.max(
          table[(baselineIndex - 1) * rowLength + currentIndex] ?? 0,
          table[baselineIndex * rowLength + currentIndex - 1] ?? 0,
        );
    }
  }

  const currentSuggested = currentCharacters.map(() => true);
  let baselineIndex = baselineCharacters.length;
  let currentIndex = currentCharacters.length;

  while (baselineIndex > 0 && currentIndex > 0) {
    if (baselineCharacters[baselineIndex - 1] === currentCharacters[currentIndex - 1]) {
      currentSuggested[currentIndex - 1] = baselineSuggested[baselineIndex - 1] ?? true;
      baselineIndex -= 1;
      currentIndex -= 1;
      continue;
    }
    if (
      (table[(baselineIndex - 1) * rowLength + currentIndex] ?? 0)
      >= (table[baselineIndex * rowLength + currentIndex - 1] ?? 0)
    ) {
      baselineIndex -= 1;
    } else {
      currentIndex -= 1;
    }
  }

  const result: ColoredPromptSegment[] = [];
  currentCharacters.forEach((character, index) => {
    const suggested = currentSuggested[index] ?? true;
    const previous = result.at(-1);
    if (previous?.suggested === suggested) {
      result[result.length - 1] = { ...previous, text: previous.text + character };
    } else {
      result.push({ text: character, suggested });
    }
  });
  return result;
}
