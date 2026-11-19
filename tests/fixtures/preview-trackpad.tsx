import { createClientRuntime } from "../../apps/workbench-web/src/runtime/client-runtime";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ZoomableImage } from "../../packages/chat-render-web/src/zoomable-image";

const inputRuntime = createClientRuntime(document);
inputRuntime.start();
const listeners = new Set<(degrees: number) => void>();
Object.assign(globalThis, {
  opencraftDesktop: {
    onTrackpadRotate(listener: (degrees: number) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  },
  releaseInputRuntime: () => inputRuntime.dispose(),
  rotateTrackpad: (degrees: number) => listeners.forEach((listener) => listener(degrees)),
  rotationSubscriptions: () => listeners.size,
});
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900"><rect width="1200" height="900" fill="#eef4ff"/><path d="M50 450H1150M600 50V850" stroke="#2563eb" stroke-width="8"/><text x="430" y="420" font-size="48">Trackpad preview</text></svg>';
function Fixture() {
  const [key, reset] = useState(0);
  const [visible, show] = useState(true);
  return (
    <>
      <button onClick={() => reset((value) => value + 1)}>Reset</button>
      <button onClick={() => show((value) => !value)}>Toggle</button>
      <div style={{ width: 700, height: 500, display: "grid", margin: 20, background: "#fff" }}>
        {visible ? (
          <ZoomableImage
            key={key}
            src={`data:image/svg+xml,${encodeURIComponent(svg)}`}
            alt="Gesture fixture"
            fitToContainer
          />
        ) : null}
      </div>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
