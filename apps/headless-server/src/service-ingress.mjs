/** Trusted channel port: storage authenticates and authorizes every operation,
 * including the second read after native completion observation. */
export function externalConversationPort(storage, execution) {
  return async (input) => {
    const hostId = execution.hostForServer(input.ref.serverId);
    const query = () => storage.externalConversation({ ...input, hostId });
    const current = await query();
    if (current.kind !== "task" || input.operation.kind === "send" || !current.receipt.targetTurnId) return current;
    const native = await execution.receipt(current.binding, current.receipt.requestId, { includeCompletion: true });
    const verified = await query();
    if (verified.kind !== "task" || verified.receipt.targetTurnId !== current.receipt.targetTurnId) return verified;
    return native?.completion?.turnId === verified.receipt.targetTurnId &&
      (!native.targetTurnId || native.targetTurnId === verified.receipt.targetTurnId)
      ? { ...verified, completion: native.completion }
      : verified;
  };
}

export function validateServiceIngress(service) {
  if (
    !service ||
    !(service.paths instanceof Set) ||
    service.paths.size < 1 ||
    service.paths.size > 32 ||
    [...service.paths].some(
      (path) =>
        typeof path !== "string" ||
        !/^\/[a-zA-Z0-9/._-]+$/u.test(path) ||
        path.startsWith("/__opencraft_") ||
        ["/health", "/rpc"].includes(path),
    ) ||
    typeof service.handle !== "function" ||
    (service.close !== undefined && typeof service.close !== "function")
  )
    throw Error("Invalid service ingress");
  return service;
}

export async function openServiceIngress(create, ports) {
  const service = await create(Object.freeze(ports));
  try {
    return validateServiceIngress(service);
  } catch (error) {
    await service?.close?.();
    throw error;
  }
}
