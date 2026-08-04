import {PersistentDirectSendIntentStore} from "./persistent-direct-send-intent-store";

export function createDirectSendIntentStore(): PersistentDirectSendIntentStore {
  return new PersistentDirectSendIntentStore(globalThis.localStorage);
}
