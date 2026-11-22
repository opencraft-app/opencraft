import { serveServerCoreOwner } from "./owner-serve.js";

/** The Server owner with no domain services; callers that serve domains start their own entry. */
serveServerCoreOwner();
