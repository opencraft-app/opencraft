import React from "react";
import { LoadingRingIcon } from "@opencraft/design-system-web/action-icons";

/** The consuming resource view retains pending state, slot and motion. */
export function LoadingSpinner() {
  return <LoadingRingIcon size={24} className="workbench-loading-spinner" />;
}
