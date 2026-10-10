export interface TerminalOutputPatch {
  data: Uint8Array;
  reset: boolean;
}

export function computeTerminalOutputPatch(
  previous: Uint8Array,
  next: Uint8Array,
): TerminalOutputPatch {
  if (next === previous) {
    return {data: new Uint8Array(), reset: false};
  }
  if (next.byteLength >= previous.byteLength && startsWith(next, previous)) {
    return {data: next.subarray(previous.byteLength), reset: false};
  }
  return {data: next, reset: true};
}

function startsWith(value: Uint8Array, prefix: Uint8Array): boolean {
  for (let index = 0; index < prefix.byteLength; index += 1) {
    if (value[index] !== prefix[index]) return false;
  }
  return true;
}
