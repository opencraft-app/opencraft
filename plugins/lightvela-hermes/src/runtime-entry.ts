import { createLightVelaHermesExtension } from "./extension";
import "./connectors/connectors.scss";

// Opaque dynamic-loader ABI; semantic extension APIs remain available from
// the normal package entry for source consumers and tests.
export default createLightVelaHermesExtension;
