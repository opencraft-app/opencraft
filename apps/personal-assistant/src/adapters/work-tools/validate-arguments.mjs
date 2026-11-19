/** Closed validation for the JSON Schema vocabulary used by the shared tools. */
export function validArguments(s, v) {
  if (s.anyOf) return s.anyOf.some((x) => validArguments(x, v));
  if (s.const !== undefined && s.const !== v) return false;
  if (s.enum && !s.enum.includes(v)) return false;
  if (s.type === "object")
    return (
      !!v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      (s.required ?? []).every((k) => Object.hasOwn(v, k)) &&
      Object.keys(v).every(
        (k) =>
          Object.hasOwn(s.properties ?? {}, k) &&
          validArguments(s.properties[k], v[k]),
      )
    );
  if (s.type === "array")
    return (
      Array.isArray(v) &&
      v.length >= (s.minItems ?? 0) &&
      v.length <= (s.maxItems ?? 1000) &&
      v.every((x) => validArguments(s.items, x))
    );
  if (s.type === "string")
    return (
      typeof v === "string" &&
      v.length >= (s.minLength ?? 0) &&
      v.length <= (s.maxLength ?? 150000)
    );
  if (s.type === "integer" || s.type === "number")
    return (
      typeof v === "number" &&
      Number.isFinite(v) &&
      (s.type !== "integer" || Number.isSafeInteger(v)) &&
      v >= (s.minimum ?? -Infinity) &&
      v <= (s.maximum ?? Infinity)
    );
  if (s.type === "boolean") return typeof v === "boolean";
  if (s.type === "null") return v === null;
  return false;
}
