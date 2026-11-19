/** Only the canonical owner's presentation projection may suppress host progress.
 * Matching words from an agent are ordinary content, never an origin signal. */
export function groupVisibleText(text,presentation) {
 return presentation?.origin==='reception'&&typeof presentation.text==='string'?presentation.text:text;
}
