import { Component, type ErrorInfo, type ReactNode } from "react";

import { reportRuntimeError } from "../runtime-error-reporting";

interface TurnRenderErrorBoundaryProps {
  readonly children: ReactNode;
  readonly resetKey: string;
}

interface TurnRenderErrorBoundaryState {
  readonly error: Error | null;
}

export class TurnRenderErrorBoundary extends Component<
  TurnRenderErrorBoundaryProps,
  TurnRenderErrorBoundaryState
> {
  public state: TurnRenderErrorBoundaryState = { error: null };

  public static getDerivedStateFromError(error: Error): TurnRenderErrorBoundaryState {
    return { error };
  }

  public componentDidCatch(error: Error, info: ErrorInfo): void {
    reportRuntimeError(error, "error-boundary", info.componentStack ?? undefined);
  }

  public componentDidUpdate(previousProps: TurnRenderErrorBoundaryProps): void {
    if (this.state.error !== null && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  public render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <div className="thread-turn-render-error" role="alert">
        <strong>This turn couldn&apos;t render</strong>
        <button type="button" onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    );
  }
}
