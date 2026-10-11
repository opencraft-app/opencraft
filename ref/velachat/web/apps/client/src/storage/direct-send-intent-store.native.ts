import AsyncStorage from "@react-native-async-storage/async-storage";

import {PersistentDirectSendIntentStore} from "./persistent-direct-send-intent-store";

export function createDirectSendIntentStore(): PersistentDirectSendIntentStore {
  return new PersistentDirectSendIntentStore(AsyncStorage);
}
