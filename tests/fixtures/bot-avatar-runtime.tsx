import { PresentationActivityProvider } from "@opencraft/react-runtime";
import type {
  BotParticipantSnapshot,
  BotPresenceFact,
} from "@opencraft/bot-conversation";
import { createConversationKey } from "@opencraft/chat-core";
import { buildOpenCraftThemeCssProperties } from "@opencraft/design-system/theme-engine";
import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import {
  BotAvatarMark,
  BotAvatarStage,
} from "../../plugins/bot-chat/src/bot-avatar-stage";
import "../../plugins/bot-chat/src/styles.scss";

type Scenario = "group" | "idle" | "send";

const key = createConversationKey("fixture", "bot-avatar-runtime");
const participants: readonly BotParticipantSnapshot[] = [
  {
    participantId: "bot:opencraft",
    kind: "bot",
    displayName: "OpenCraft",
    avatar: {
      kind: "monogram",
      text: "O",
      background: "#1677ff",
      foreground: "#f8fbff",
    },
  },
  {
    participantId: "bot:nova",
    kind: "bot",
    displayName: "Nova",
    avatar: {
      kind: "monogram",
      text: "N",
      background: "#d95f3f",
      foreground: "#fff8f5",
    },
  },
  {
    participantId: "bot:muse",
    kind: "bot",
    displayName: "Muse",
    avatar: {
      kind: "monogram",
      text: "M",
      background: "#2f9d70",
      foreground: "#f4fffa",
    },
  },
];

function presenceFor(scenario: Scenario): readonly BotPresenceFact[] {
  if (scenario === "idle") return [];
  return [
    {
      conversationKey: key,
      participantId: "bot:opencraft",
      executionId: `fixture:${scenario}`,
      seq: 1,
      phase: "working",
      activity: {
        verb: scenario === "send" ? "messaging" : "running",
        detail: scenario === "send" ? "Handing work to Nova" : "Building",
        targetParticipantId: "bot:nova",
      },
      observedAtMs: 1,
      expiresAtMs: Number.MAX_SAFE_INTEGER,
    },
  ];
}

function setTheme(theme: "light" | "dark"): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  const properties = buildOpenCraftThemeCssProperties(theme);
  for (const [name, value] of Object.entries(properties))
    document.documentElement.style.setProperty(name, value);
  document.documentElement.style.setProperty(
    "--color-background-primary",
    properties["--color-background-surface"],
  );
  document.documentElement.style.setProperty(
    "--color-background-secondary",
    properties["--color-background-panel"],
  );
}

setTheme("light");

function Demo() {
  const [active, setActive] = useState(true);
  const [scenario, setScenario] = useState<Scenario>("group");
  const presence = useMemo(() => presenceFor(scenario), [scenario]);
  const fixture = window as typeof window & {
    botAvatarFixture?: {
      active(value: boolean): void;
      scenario(value: Scenario): void;
      theme(value: "light" | "dark"): void;
    };
  };
  fixture.botAvatarFixture = { active: setActive, scenario: setScenario, theme: setTheme };
  return (
    <main className="avatar-fixture">
      <header>
        <p>OpenCraft Bot runtime</p>
        <h1>One team, one motion hierarchy</h1>
      </header>
      <PresentationActivityProvider active={active}><BotAvatarStage presence={presence}>
        <section className="avatar-fixture__team" aria-label="Bot team">
          {participants.map((participant) => (
            <article key={participant.participantId}>
              <BotAvatarMark
                followPointer
                participant={participant}
                size="large"
              />
              <strong>{participant.displayName}</strong>
              <span>
                {participant.participantId === "bot:opencraft"
                  ? "Executing"
                  : participant.participantId === "bot:nova"
                    ? "Handoff"
                    : "Available"}
              </span>
            </article>
          ))}
        </section>
      </BotAvatarStage></PresentationActivityProvider>
    </main>
  );
}

const style = document.createElement("style");
style.textContent = `
  * { box-sizing: border-box; }
  html, body, #root { min-height: 100%; margin: 0; }
  body { background: var(--color-background-primary); color: var(--color-text); font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
  .avatar-fixture { width: min(760px, calc(100vw - 48px)); margin: 72px auto; }
  .avatar-fixture header p { margin: 0 0 8px; color: var(--color-text-tertiary); font-size: 13px; }
  .avatar-fixture header h1 { margin: 0 0 32px; font-size: 28px; font-weight: 620; }
  .avatar-fixture__team { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
  .avatar-fixture__team article { display: grid; min-height: 156px; place-items: center; align-content: center; gap: 10px; border: 1px solid var(--color-border-default); border-radius: 18px; background: var(--color-background-secondary); }
  .avatar-fixture__team .bot-chat-mark-anchor { transform: scale(1.65); margin-bottom: 12px; }
  .avatar-fixture__team strong { font-size: 14px; }
  .avatar-fixture__team span:last-child { color: var(--color-text-tertiary); font-size: 12px; }
`;
document.head.append(style);
createRoot(document.getElementById("root")!).render(<Demo />);
