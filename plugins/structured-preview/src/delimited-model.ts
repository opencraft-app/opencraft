/** Preserve cell text: no numeric/date coercion, formula evaluation or HTML. */
export function decodeDelimitedBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le", { fatal: true }).decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be", { fatal: true }).decode(bytes);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return new TextDecoder("gb18030", { fatal: true }).decode(bytes); }
}

export function parseDelimited(text: string, delimiter: "," | "\t"): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], value = "", quoted = false, closed = false, cells = 0;
  const cell = () => {
    if (++cells > 1_000_000 || row.length >= 4096) throw new Error("Table exceeds preview limits");
    row.push(value); value = ""; closed = false;
  };
  const line = () => {
    cell();
    if (rows.length >= 100_000) throw new Error("Table exceeds preview limits");
    rows.push(row); row = [];
  };
  text = text.replace(/^\uFEFF/u, "");
  if (text.length === 0) return [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { value += '"'; i++; }
        else { quoted = false; closed = true; }
      } else value += char;
    } else if (char === delimiter) cell();
    else if (char === "\r" || char === "\n") {
      line(); if (char === "\r" && text[i + 1] === "\n") i++;
    } else if (closed) {
      if (char !== " " && char !== "\t") throw new Error("Unexpected content after a quoted cell");
    } else if (char === '"' && value === "") quoted = true;
    else value += char;
  }
  if (quoted) throw new Error("Unclosed quoted cell");
  if (row.length || value !== "" || closed || text.endsWith(delimiter)) line();
  return rows;
}

export function columnLabel(index: number): string {
  let label = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) label = String.fromCharCode(65 + (n - 1) % 26) + label;
  return label;
}
