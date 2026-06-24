import React from "react";
import { createRoot } from "react-dom/client";
import { DesktopApp } from "./DesktopApp";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");

createRoot(root).render(
  <React.StrictMode>
    <DesktopApp />
  </React.StrictMode>,
);

