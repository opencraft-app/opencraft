import { serveWorkerOwner } from "@opencraft/worker-owner/serve";
import { openParticipantStore } from "./participant-store";

/** Owns the participant rows of one Host database for the Host's network process. */
serveWorkerOwner(openParticipantStore);
