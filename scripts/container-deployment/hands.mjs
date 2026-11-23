import { startContainerHands } from "./hands-application.mjs";
import { startRootHands } from "./root-hands.mjs";

// UID 0 is never an implicit single-identity Hands: it requires the explicit
// root/client contract (compose.root-hands.yaml) and fails closed without it.
if (process.getuid?.() === 0) await startRootHands();
else await startContainerHands();
