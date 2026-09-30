const TEXT_INPUT_OWNER = "input, textarea, select, button, a, summary, [contenteditable='true'], [role='textbox'], [role='button'], [role='dialog'], [role='menu'], [data-disable-type-to-compose='true']";

export function shouldTypeToCompose(event: KeyboardEvent): boolean {
  // IME may identify its first key as 229 before isComposing becomes true.
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 ||
      event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) {
    return false;
  }
  // Window-level event.target is the custom element when an editor lives in
  // Shadow DOM. Use the composed path to preserve the actual input owner.
  const path = event.composedPath();
  return !(path.length > 0 ? path : [event.target]).some((target) =>
    target instanceof Element && target.closest(TEXT_INPUT_OWNER) !== null,
  );
}
