import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";

export interface ChatDocumentErrorFallbackProps {
  readonly error: Error;
  readonly source: string;
  readonly retry: () => void;
}

interface Props {
  readonly source: string;
  readonly fallback: (props: ChatDocumentErrorFallbackProps) => ReactNode;
  readonly children: ReactNode;
}

interface State {
  readonly error: Error | null;
  readonly retryKey: number;
}

export class ChatDocumentErrorBoundary extends Component<Props, State> {
  state: State = { error: null, retryKey: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // The host runtime error boundary remains the telemetry authority.
  }

  componentDidUpdate(previous: Props): void {
    if (this.state.error !== null && previous.source !== this.props.source) {
      this.setState((state) => ({ error: null, retryKey: state.retryKey + 1 }));
    }
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      return this.props.fallback({
        error: this.state.error,
        source: this.props.source,
        retry: () => this.setState((state) => ({ error: null, retryKey: state.retryKey + 1 })),
      });
    }
    return <Fragment key={this.state.retryKey}>{this.props.children}</Fragment>;
  }
}
