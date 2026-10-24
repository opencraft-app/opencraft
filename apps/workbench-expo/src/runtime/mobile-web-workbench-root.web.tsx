// The browser validation path uses the packaged document too, rather than
// silently substituting the old React Native Web workbench.
export function MobileWebWorkbenchRoot() {
  return <iframe title="OpenCraft" src="/mobile-workbench.html" style={{ width: "100vw", height: "100dvh", border: 0 }} />;
}
