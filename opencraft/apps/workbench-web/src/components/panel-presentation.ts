import { createContext, useContext } from "react";

/** Physical outlet visibility, separate from resource residency. */
export const PanelPresentationContext = createContext({ active: false, region: "right" as "right" | "bottom" });
export const usePanelPresentation = () => useContext(PanelPresentationContext);
