/** Interpret local editing intent once. The receiver contains only staging
 * text, so deletion and line breaks must use inputType rather than its value. */
export class RemoteBrowserEditInput {
  private handled: string | null = null;
  constructor(private readonly receiver: HTMLInputElement,
    private readonly available: () => boolean, private readonly composing: () => boolean,
    private readonly commit: (text: string) => void, private readonly key: (key: string) => void,
    private readonly edit?: (command: string) => void) {}
  retire() { this.handled = null; }
  beforeInput(event: InputEvent) {
    this.handled = null;
    if (this.ignored(event) || !event.cancelable) return;
    if (this.apply(event, false)) { event.preventDefault(); this.handled = event.inputType; }
  }
  input(event: InputEvent) {
    const handled = this.handled; this.handled = null;
    if (this.ignored(event)) return;
    // A browser honoring preventDefault emits no input. If an input still
    // follows the canceled beforeinput, do not apply that same edit twice.
    if (handled !== event.inputType) this.apply(event, true);
    this.receiver.value = '';
  }
  private ignored(event: InputEvent) {
    return this.composing() || event.isComposing || event.inputType.includes('Composition') || !this.available();
  }
  private apply(event: InputEvent, fallback: boolean) {
    const command = ({ historyUndo: 'undo', historyRedo: 'redo', deleteWordBackward: 'deleteWordBackward',
      deleteWordForward: 'deleteWordForward' } as Record<string, string>)[event.inputType];
    if (command && this.edit) { this.edit(command); return true; }
    const key = ({ deleteContentBackward: 'Backspace', deleteContentForward: 'Delete',
      insertLineBreak: 'Return', insertParagraph: 'Return' } as Record<string, string>)[event.inputType];
    if (key) { this.key(key); return true; }
    // A trailing input after compositionend may repeat data after the IME
    // already cleared staging. Only actual staged text can be committed here.
    const text = fallback ? this.receiver.value : event.inputType === 'insertText' ? event.data : '';
    if (!text) return false;
    this.commit(text); return true;
  }
}
