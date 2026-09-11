import { createLightVelaHermesExtension } from "./extension";
import "./connectors/connectors.scss";
import "./upstream/agent-console.css";

// Opaque dynamic-loader ABI; semantic extension APIs remain available from
// the normal package entry for source consumers and tests.
export default createLightVelaHermesExtension;
