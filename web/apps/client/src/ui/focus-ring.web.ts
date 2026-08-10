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

    /* Field chrome paints its own focus ring (border + glow). A second
       outline on the same control, or on a nested input, reads as a double
       halo — suppress it wherever a field has opted in. */
    [data-vela-field]:focus-visible,
    [data-vela-field] :is(input, textarea):focus-visible {
      outline: none;
    }
  `;
  document.head.appendChild(style);
}

installFocusRing();
