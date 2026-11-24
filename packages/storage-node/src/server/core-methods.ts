import type { SqlDatabase } from "@opencraft/sql";
import { conversationCreationReceiptMethods } from "./conversation-creation-receipts.js";
import { conversationResourceMethods, type ConversationResourceLegacyJournal } from "./conversation-resources.js";
import { accountModelDefaultsMethods } from "./account-model-defaults.js";
import { environmentCreationReservationMethods } from "./environment-creation-reservations.js";
import { actorSshKeyMethods } from "./actor-ssh-keys.js";
import { threadReadReceiptMethods } from "./thread-read-receipts.js";

/**
 * The storage methods every Server core owner serves on its own connection,
 * whatever runs it (runtime-neutral): the Node owner Worker
 * (`serveServerCoreOwner`) and an owner on the authorizer's own thread (the
 * InstallationCore Durable Object). Only the Node owner has the retired
 * conversation resource journal beside its file; other owners pass none.
 */
export function serverCoreStorageMethods(database: SqlDatabase, legacyJournal?: ConversationResourceLegacyJournal) {
  return {
    ...conversationCreationReceiptMethods(database),
    ...conversationResourceMethods(database, legacyJournal),
    ...accountModelDefaultsMethods(database),
    ...environmentCreationReservationMethods(database),
    ...actorSshKeyMethods(database),
    ...threadReadReceiptMethods(database),
  };
}
