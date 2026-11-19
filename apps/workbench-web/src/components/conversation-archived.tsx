import React, {lazy, Suspense} from "react";
import type {ComponentProps} from "react";
import type * as State from "./conversation-archived-state";
const UnavailableState = lazy(() => import("./conversation-archived-state").then(module => ({default: module.ConversationUnavailableState})));
const ArchivedBadge = lazy(() => import("./conversation-archived-state").then(module => ({default: module.ConversationArchivedBadge})));
export function ConversationUnavailableState(props: ComponentProps<typeof State.ConversationUnavailableState>) {
  return <Suspense fallback={null}><UnavailableState {...props} /></Suspense>;
}
export function ConversationArchivedBadge() {
  return <Suspense fallback={null}><ArchivedBadge /></Suspense>;
}
