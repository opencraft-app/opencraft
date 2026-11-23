import { serveWorkerOwner } from "@opencraft/worker-owner/serve";
import { openLoginAdmissionStore } from "./store";

/** Owns `login-admission.sqlite` for the Hub's network process. */
serveWorkerOwner(openLoginAdmissionStore);
