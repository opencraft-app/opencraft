import { Component, type ErrorInfo, type ReactNode } from "react";

import { reportRuntimeError } from "../runtime-error-reporting";

interface RuntimeErrorBoundaryProps {
  children: ReactNode;
}

interface RuntimeErrorBoundaryState {
  error?: Error;
}

export class RuntimeErrorBoundary extends Component<
  RuntimeErrorBoundaryProps,
  RuntimeErrorBoundaryState
> {
  public state: RuntimeErrorBoundaryState = {};

  public static getDerivedStateFromError(error: Error): RuntimeErrorBoundaryState {
    return { error };
  }

  public componentDidCatch(error: Error, info: ErrorInfo): void {
    reportRuntimeError(error, "error-boundary", info.componentStack ?? undefined);
  }

  public render(): ReactNode {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }

    return (
      <main className="runtime-error" role="alert">
        <section className="runtime-error__card">
          <span className="runtime-error__eyebrow">OpenCraft runtime</span>
          <h1>界面组件未能启动</h1>
          <p>错误已经回传到本机开发服务器，页面不会再静默黑屏。</p>
          <pre>{`${error.name}: ${error.message}`}</pre>
          <button type="button" onClick={() => window.location.reload()}>
            重新加载
          </button>
        </section>
      </main>
    );
  }
}

