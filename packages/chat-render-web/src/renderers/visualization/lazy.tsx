import { lazy, Suspense } from "react";
import { useIntl } from "@opencraft/i18n/react";
import type { ChatNodeRendererProps, ChatResourcePolicyService } from "@opencraft/chat-render-react";

const LazyVisualization = lazy(() => import("./visualization").then(module => ({ default: module.Visualization })));

export function createVisualizationRenderer(resources: ChatResourcePolicyService) {
  return function VisualizationBoundary(props: ChatNodeRendererProps) {
    const intl = useIntl();
    return <Suspense fallback={<div role="status">{intl.formatMessage({ id: "chat.visualization.loading", defaultMessage: "Loading visualization…" })}</div>}>
      <LazyVisualization {...props} resources={resources} />
    </Suspense>;
  };
}
