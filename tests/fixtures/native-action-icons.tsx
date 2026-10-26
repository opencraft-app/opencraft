import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Pressable, Text } from "react-native";
import * as icons from "@opencraft/design-system-native/action-icons";
import { WorkbenchHeader } from "../../apps/mobile/src/components/workbench-header";
import { WorkbenchSidebar } from "../../apps/mobile/src/components/workbench-sidebar";
import { NativeCodeRenderer } from "../../packages/chat-render-native/src/renderers/code";
import { NativeImageGalleryProvider, useNativeImageGallery } from "../../packages/chat-render-native/src/renderers/image-gallery";

// Production Native controls and SVG web adapter; only app data/callbacks are
// synthetic. This browser fixture does not emulate physical iOS/Android input.
const image = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" rx="8" fill="#326abc"/></svg>');
function GalleryTrigger() {
  const gallery = useNativeImageGallery();
  useEffect(() => {
    const remove = [0, 1].map(i => gallery!.register({ key: String(i), source: image, alt: `Synthetic image ${i}`, order: i }));
    return () => remove.forEach(fn => fn());
  }, [gallery]);
  return <Pressable accessibilityRole="button" accessibilityLabel="Open synthetic gallery" onPress={() => gallery!.open({ key: "0", source: image, alt: "Synthetic image 0", order: 0 })}><Text>Open synthetic gallery</Text></Pressable>;
}
function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [created, setCreated] = useState(0);
  const dark = new URLSearchParams(location.search).get("theme") === "dark";
  const color = dark ? "#eff1f4" : "#20242a";
  const names = Object.keys(icons).filter(name => name.endsWith("Icon"));
  return <>
    <style>{`html, body, #root { height: auto; min-height: 100%; } body { margin: 0; overflow: auto; } #root { display: block; }`}</style>
    <main style={{ color, background: dark ? "#14171c" : "#fafbfc", padding: 12, minHeight: "100vh" }}>
    <section data-native-consumer style={{ background: "#fff", color: "#20242a", border: "1px solid #d4d7dc", borderRadius: 8, overflow: "hidden" }}>
      <WorkbenchHeader thread={{ id: "synthetic", title: "Synthetic task", project: "Fixture" } as any}
        hostLabel="Local" hostPhase="ready" sidebarOpen={sidebarOpen} topInset={0} onToggleSidebar={() => setSidebarOpen(true)} />
      {sidebarOpen ? <WorkbenchSidebar threads={[]} activeThreadId="" topInset={0} onSelectThread={() => {}}
        onNewTask={() => setCreated(value => value + 1)} onClose={() => setSidebarOpen(false)} /> : null}
      <p data-created style={{ padding: "0 12px" }}>Created: {created}</p>
      <NativeCodeRenderer node={{ kind: "code-fence", id: "synthetic-code", code: "const synthetic = 42;", language: "typescript", completeness: "complete" } as any}
        context={{ theme: "light" } as any} />
      <NativeImageGalleryProvider scopeKey="synthetic"><GalleryTrigger /></NativeImageGalleryProvider>
    </section>
    <h2 style={{ font: "500 16px system-ui", marginTop: 24 }}>Shared Native action artwork</h2>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(136px,1fr))", gap: 8 }}>
      {names.map(name => {
        const Icon = (icons as any)[name];
        return <div key={name} data-native-icon={name} style={{ border: "1px solid #7a818b", borderRadius: 6, padding: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>{[14, 16, 20, 24].map(size => <Icon key={size} size={size} color={color} />)}</div>
          <p style={{ font: "10px system-ui", marginBottom: 0 }}>{name}</p>
        </div>;
      })}
    </div>
    </main>
  </>;
}
createRoot(document.getElementById("root")!).render(<App />);
