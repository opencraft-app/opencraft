import { ModelGatewayStore, type ModelGatewayTokenUsage } from "./model-gateway-store.js";
import { observeModelGatewayResponse } from "./model-gateway-usage.js";

export { ModelGatewayUsageReceipt } from "./model-gateway-usage.js";

/** Owns a reservation until a terminal usage receipt or an explicitly unknown
 * outcome. The upstream callback must run immediately before dispatch. */
export async function meteredModelRequest(options: {
  path: string;
  thread: string;
  turn?: string | null;
  model: string;
  signal: AbortSignal;
  send: (dispatch: (credential?: string) => void) => Promise<Response>;
}): Promise<Response> {
  const store = new ModelGatewayStore(options.path);
  let reservation;
  try { options.signal.throwIfAborted(); reservation = store.reserve(options.thread, options.model, options.turn); }
  catch (error) { store.close(); throw error; }
  let finished = false;
  const finish = (actual: number | null, usage?: ModelGatewayTokenUsage) => {
    if (finished) return;
    finished = true;
    options.signal.removeEventListener("abort", abort);
    try { store.finish(reservation.id, actual, usage); } finally { store.close(); }
  };
  const abort = () => { try { finish(null); } catch { /* Durable reservation remains held. */ } };
  options.signal.addEventListener("abort", abort, { once: true });
  try {
    const result = await options.send(credential => {
      options.signal.throwIfAborted();
      store.dispatched(reservation.id, credential ?? options.model);
    });
    options.signal.throwIfAborted();
    if (!result.ok || !result.body) { finish(null); return result; }
    return observeModelGatewayResponse(result, finish);
  } catch (error) { finish(null); throw error; }
}
