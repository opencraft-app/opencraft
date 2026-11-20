export function parseInputCompletion(value, turnId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value;
  if (v.version !== 1 || v.turnId !== turnId || typeof v.status !== "string" || !["unknown", "completed", "failed", "interrupted"].includes(v.status)
    || !(v.truncated === undefined || typeof v.truncated === "boolean") || typeof v.text !== "string" || v.text.length > 16000
    || !(v.unavailable === undefined || v.unavailable === true)) return undefined;
  if (v.status !== "unknown" && (!turnId || turnId === "unknown" || v.unavailable)) return undefined;
  if (v.status === "unknown" && (v.text !== "" || v.truncated)) return undefined;
  return { version:1, turnId, status:v.status, text:v.text,
    truncated:v.truncated === true, ...(v.unavailable ? {unavailable:true} : {}) };
}

