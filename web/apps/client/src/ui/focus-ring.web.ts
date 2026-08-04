import {raftTheme} from "./tokens";

const focusRingStyleId = "raft-focus-ring";
const focusableSelector = [
  "button",
  "a",
  "input",
  "textarea",
  "select",
  '[role="button"]',
  "[tabindex]",
].join(", ");

function installFocusRing() {
  if (typeof document === "undefined" || document.getElementById(focusRingStyleId)) {
    return;
  }

  const style = document.createElement("style");
  style.id = focusRingStyleId;
  style.textContent = `
    :where(${focusableSelector}):focus {
      outline: none;
    }

    :where(${focusableSelector}):focus-visible {
      outline: ${raftTheme.semantic.interaction.focusRingWidth}px solid ${raftTheme.semantic.color.borderFocus};
      outline-offset: ${raftTheme.semantic.interaction.focusRingOffset}px;
    }
  `;
  document.head.appendChild(style);
}

installFocusRing();
