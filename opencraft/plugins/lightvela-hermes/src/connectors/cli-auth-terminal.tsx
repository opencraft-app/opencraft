import { useEffect, useRef } from "react";
import type { Terminal } from "@xterm/xterm";

export function CliAuthTerminal({ output, offset, ready, onData, onResize }: {
  output: string; offset: number; ready: boolean;
  onData(data: string): void; onResize(cols: number, rows: number): void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const cursor = useRef(0);
  const callbacks = useRef({onData, onResize, ready});
  callbacks.current = {onData, onResize, ready};
  useEffect(() => {
    let disposed = false;
    let mountedTerminal: Terminal | null = null;
    let observer: ResizeObserver | null = null;
    let input: { dispose(): void } | null = null;
    let resize: { dispose(): void } | null = null;

    const mount = async () => {
      // Xterm and its CSS are renderer resources. Loading both from the View
      // lifetime keeps the extension module importable by Node hosts/tests.
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        // @ts-ignore -- Vite resolves this renderer-only CSS module; the
        // extension source is also typechecked through both Vite and Expo TS
        // programs, which intentionally have different CSS module visibility.
        import("@xterm/xterm/css/xterm.css"),
      ]);
      const slot = element.current;
      if (disposed || slot === null) return;
      const term = new Terminal({cols: 80, rows: 24, fontSize: 14, scrollback: 1000, disableStdin: !callbacks.current.ready});
      const fit = new FitAddon(); term.loadAddon(fit);
      term.open(slot); terminal.current = term; mountedTerminal = term; cursor.current = 0;
      input = term.onData(data => { if (callbacks.current.ready) callbacks.current.onData(data); });
      resize = term.onResize(({cols, rows}) => callbacks.current.onResize(cols, rows));
      observer = new ResizeObserver(() => fit.fit()); observer.observe(slot); fit.fit();
    };
    void mount();
    return () => {
      disposed = true;
      observer?.disconnect();
      input?.dispose();
      resize?.dispose();
      terminal.current = null;
      mountedTerminal?.dispose();
    };
  }, []);
  useEffect(() => {
    const term = terminal.current; if (!term) return;
    if (cursor.current < offset) { term.reset(); cursor.current = offset; }
    const end = offset + output.length;
    if (end > cursor.current) term.write(output.slice(cursor.current - offset));
    cursor.current = end;
  }, [output, offset]);
  useEffect(() => {
    if (terminal.current) { terminal.current.options.disableStdin = !ready; if (ready) {terminal.current.focus(); onResize(terminal.current.cols, terminal.current.rows);} }
  }, [ready]);
  return <div ref={element} aria-label="CLI 授权终端" style={{height: 360, minWidth: 0, overflow: "hidden", background: "#000", padding: 8}} />;
}
