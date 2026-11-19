import React, { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { WebConversationViewportOwner, setTimelineDiagnosticObserver } from "@opencraft/timeline-host-web";
import { asTurnId, type TimelineTurnView } from "@opencraft/chat-core";
import { VirtualizedConversationTurns } from "../../apps/workbench-web/src/components/conversation/virtualized-conversation-turns";

// Recorded dimensions, never message content or production identifiers. Keep
// existing keys stable when a page is prepended, as the real timeline does.
const heights = [
  1642.03125, 477.078125, 2248.703125, 1047.0625, 1999.046875, 1144.328125, 1869.203125, 414.140625, 1472.3125, 517.375,
  365.5,
];
type Entry = TimelineTurnView & { readonly height: number };
const rows = (values: readonly number[], prefix: string): Entry[] =>
  values.map((height, index) => ({
    type: "turn",
    turnKey: `${prefix}-${index}`,
    turnId: asTurnId(`${prefix}-${index}`),
    status: "complete",
    frames: [],
    height,
  }));
const initial = rows(heights, "existing");
const older = rows([2638, 1214, 1927, 1564, 1414, 1300, 900, 1000, 1200, 1800], "older");
const owner = new WebConversationViewportOwner(0);
const probe = window as any;
probe.owner = owner;
probe.events = [];
probe.setDiagnostics = (enabled: boolean) =>
  setTimelineDiagnosticObserver(
    enabled ? (kind, fields) => probe.events.push({ at: performance.now(), kind, fields }) : undefined,
  );
const publishApi = (api: unknown) => {
  probe.api = api;
};

function Fixture() {
  const [state, setState] = useState({ entries: initial, revision: 0 });
  probe.prependHistory = () =>
    flushSync(() =>
      setState((current) => ({
        entries: [...older, ...current.entries],
        revision: current.revision + 1,
      })),
    );
  useLayoutEffect(() => owner.bindScrollBehavior({}), []);
  return (
    <div ref={owner.attachScrollElement} className="thread-scroll">
      <div className="thread-scroll-surface">
        <div className="thread-content">
          <VirtualizedConversationTurns
            entries={state.entries}
            timelineRevision={state.revision}
            viewportOwner={owner}
            initialRestoreState={null}
            initialDistanceFromBottomPx={0}
            preserveMeasuredTurnViewport
            expandToMountedContent
            onApiChange={publishApi}
            renderTurn={(turn) => {
              const entry = turn as Entry;
              return (
                <div style={{ height: entry.height }} data-probe={entry.turnKey}>
                  {Array.from({ length: Math.floor(entry.height / 24) }, (_, index) => (
                    <p key={index}>
                      {entry.turnKey} paragraph {index}
                    </p>
                  ))}
                </div>
              );
            }}
          />
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
