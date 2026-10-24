import { Component, type ErrorInfo, type ReactNode } from "react";

import { reportRuntimeError } from "../runtime-error-reporting";
import { BrowserStorageError } from "../runtime/browser-storage-error";

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

    if (error instanceof BrowserStorageError) {
      return (
        <main className="runtime-error" role="alert">
          <section className="runtime-error__card">
            <h1>暂时无法打开工作台</h1>
            <p>{error.reason === "unavailable"
              ? "浏览器暂时无法读取已保存的配置，请重新加载后重试。"
              : "请关闭此站点的其他标签页或窗口，然后重新加载。"}</p>
            <p>已保存的配置会保留。</p>
            <button type="button" onClick={() => window.location.reload()}>重新加载</button>
          </section>
        </main>
      );
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

