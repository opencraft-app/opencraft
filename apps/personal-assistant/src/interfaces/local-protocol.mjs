/** The protocol validates envelopes only. Actor/scope and business commands are application responsibilities. */
export function validateRequest(request) {
  if (
    !request ||
    typeof request !== "object" ||
    typeof request.op !== "string" ||
    !request.params ||
    typeof request.params !== "object" ||
    Array.isArray(request.params)
  )
    throw new Error("Expected {op,id,params}");
  return request;
}
