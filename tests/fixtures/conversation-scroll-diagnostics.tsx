import "./conversation-scroll";
import { setTimelineDiagnosticObserver } from "@opencraft/timeline-host-web";
import { captureLocalDiagnostics, isLocalDiagnosticsEnabled, recordLocalDiagnostic, setLocalDiagnosticsEnabled, subscribeLocalDiagnostics } from "../../apps/workbench-web/src/runtime/local-diagnostics";

const update = () => setTimelineDiagnosticObserver(isLocalDiagnosticsEnabled() ? recordLocalDiagnostic : undefined);
subscribeLocalDiagnostics(update); update();
const probe = window as any;
probe.setDiagnostics = setLocalDiagnosticsEnabled;
probe.captureDiagnostics = captureLocalDiagnostics;
