import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

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
    const term = new Terminal({cols: 80, rows: 24, fontSize: 14, scrollback: 1000, disableStdin: !callbacks.current.ready});
    const fit = new FitAddon(); term.loadAddon(fit);
    term.open(element.current!); terminal.current = term; cursor.current = 0;
    const input = term.onData(data => { if (callbacks.current.ready) callbacks.current.onData(data); });
    const resize = term.onResize(({cols, rows}) => callbacks.current.onResize(cols, rows));
    const observer = new ResizeObserver(() => fit.fit()); observer.observe(element.current!); fit.fit();
    return () => {observer.disconnect(); input.dispose(); resize.dispose(); terminal.current = null; term.dispose();};
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
