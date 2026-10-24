import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { FormattedMessage, useIntl } from "@opencraft/i18n/react";
import { writeTextToClipboard } from "@opencraft/chat-render-web/clipboard";

import "../styles/internal-developer-diagnostics.scss";

import {
  captureRuntimeEnvironment,
  clearRuntimeDiagnostics,
  formatDiagnosticsCopy,
  getRuntimeDiagnosticsSnapshot,
  probeCssSupports,
  subscribeRuntimeDiagnostics,
  type RuntimeDiagnosticErrorEntry,
} from "../runtime-diagnostics";

const EMPTY_SNAPSHOT = { errors: [], network: [] };

function useDiagnosticsSnapshot() {
  return useSyncExternalStore(subscribeRuntimeDiagnostics, getRuntimeDiagnosticsSnapshot, () => EMPTY_SNAPSHOT);
}

function formatTime(at: number): string {
  const date = new Date(at);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function ErrorRow({ entry }: { readonly entry: RuntimeDiagnosticErrorEntry }) {
  const [open, setOpen] = useState(false);
  const hasDetail = Boolean(entry.stack || entry.componentStack);
  return (
    <li className="internal-developer-diagnostics__item">
      <div className="internal-developer-diagnostics__item-head">
        <time dateTime={new Date(entry.at).toISOString()}>{formatTime(entry.at)}</time>
        <span>{entry.source}</span>
      </div>
      <p>{entry.message}</p>
      {hasDetail ? (
        <>
          <button type="button" onClick={() => setOpen((value) => !value)}>
            {open
              ? <FormattedMessage id="developerMode.hideStack" defaultMessage="Hide stack" />
              : <FormattedMessage id="developerMode.showStack" defaultMessage="Show stack" />}
          </button>
          {open ? (
            <pre>
              {entry.stack}
              {entry.componentStack ? `\n${entry.componentStack}` : ""}
            </pre>
          ) : null}
        </>
      ) : null}
    </li>
  );
}

export function InternalDeveloperDiagnostics() {
  const intl = useIntl();
  const snapshot = useDiagnosticsSnapshot();
  const [open, setOpen] = useState(false);
  const [copyFallback, setCopyFallback] = useState<string | null>(null);
  const environment = useMemo(() => captureRuntimeEnvironment(), [open]);
  const css = useMemo(() => probeCssSupports(), [open]);
  const copyText = useMemo(
    () => formatDiagnosticsCopy({ environment, css, errors: snapshot.errors, network: snapshot.network }),
    [environment, css, snapshot],
  );

  useEffect(() => {
    if (!open) setCopyFallback(null);
  }, [open]);

  const copyAll = () => {
    void writeTextToClipboard(copyText).then(
      () => setCopyFallback(null),
      () => setCopyFallback(copyText),
    );
  };

  return (
    <div className="internal-developer-diagnostics">
      <button
        type="button"
        className="internal-developer-diagnostics__fab"
        aria-expanded={open}
        aria-controls="internal-developer-diagnostics-panel"
        onClick={() => setOpen((value) => !value)}
      >
        <FormattedMessage id="developerMode.diagnostics" defaultMessage="Diagnostics" />
      </button>
      {open ? (
        <section
          id="internal-developer-diagnostics-panel"
          className="internal-developer-diagnostics__panel"
          role="dialog"
          aria-label={intl.formatMessage({ id: "developerMode.panelTitle", defaultMessage: "Diagnostics" })}
        >
          <header>
            <h2><FormattedMessage id="developerMode.panelTitle" defaultMessage="Diagnostics" /></h2>
            <button type="button" onClick={() => setOpen(false)}>
              <FormattedMessage id="developerMode.close" defaultMessage="Close" />
            </button>
          </header>
          <div className="internal-developer-diagnostics__body">
            <section>
              <h3><FormattedMessage id="developerMode.errors" defaultMessage="Errors" /></h3>
              {snapshot.errors.length === 0
                ? <p><FormattedMessage id="developerMode.emptyErrors" defaultMessage="No captured errors." /></p>
                : (
                  <ol>
                    {snapshot.errors.slice().reverse().map((entry, index) => (
                      <ErrorRow key={`${entry.at}-${index}`} entry={entry} />
                    ))}
                  </ol>
                )}
            </section>
            <section>
              <h3><FormattedMessage id="developerMode.network" defaultMessage="Network" /></h3>
              {snapshot.network.length === 0
                ? <p><FormattedMessage id="developerMode.emptyNetwork" defaultMessage="No failed requests." /></p>
                : (
                  <ol>
                    {snapshot.network.slice().reverse().map((entry, index) => (
                      <li key={`${entry.at}-${index}`} className="internal-developer-diagnostics__item">
                        <div className="internal-developer-diagnostics__item-head">
                          <time dateTime={new Date(entry.at).toISOString()}>{formatTime(entry.at)}</time>
                          <span>{entry.channel} {entry.event}</span>
                        </div>
                        <pre>{[
                          entry.path,
                          entry.status === undefined ? "" : String(entry.status),
                          entry.durationMs === undefined ? "" : String(entry.durationMs),
                          entry.code === undefined ? "" : String(entry.code),
                        ].filter(Boolean).join(" ")}</pre>
                      </li>
                    ))}
                  </ol>
                )}
            </section>
            <section>
              <h3><FormattedMessage id="developerMode.environment" defaultMessage="Environment" /></h3>
              <pre>{formatDiagnosticsCopy({ environment, css: [], errors: [], network: [] }).replace(/\n## CSS[\s\S]*$/u, "").trim()}</pre>
            </section>
            <section>
              <h3><FormattedMessage id="developerMode.css" defaultMessage="CSS support" /></h3>
              <pre>{css.map((probe) => `${probe.label}: ${probe.supported === null ? "?" : probe.supported ? "1" : "0"}`).join("\n")}</pre>
            </section>
          </div>
          <footer>
            <button type="button" onClick={copyAll}>
              <FormattedMessage id="developerMode.copyAll" defaultMessage="Copy all" />
            </button>
            <button type="button" onClick={() => { clearRuntimeDiagnostics(); setCopyFallback(null); }}>
              <FormattedMessage id="developerMode.clear" defaultMessage="Clear" />
            </button>
          </footer>
          {copyFallback !== null ? (
            <label className="internal-developer-diagnostics__fallback">
              <FormattedMessage id="developerMode.copyFallback" defaultMessage="Select and copy this report" />
              <textarea readOnly value={copyFallback} onFocus={(event) => event.currentTarget.select()} />
            </label>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
