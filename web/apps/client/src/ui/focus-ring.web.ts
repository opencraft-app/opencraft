import {velaTheme} from "./tokens";

const focusRingStyleId = "vela-focus-ring";
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
      outline: ${velaTheme.semantic.interaction.focusRingWidth}px solid ${velaTheme.semantic.color.borderFocus};
      outline-offset: ${velaTheme.semantic.interaction.focusRingOffset}px;
    }
  `;
  document.head.appendChild(style);
}

installFocusRing();
