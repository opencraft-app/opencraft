import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";

import { App } from "@/app/app";

const app = (
  <StrictMode>
    <App />
  </StrictMode>
);

export function mountApp(rootElement: HTMLElement) {
  if (rootElement.innerHTML.trim()) {
    hydrateRoot(rootElement, app);
    return;
  }

  createRoot(rootElement).render(app);
}
