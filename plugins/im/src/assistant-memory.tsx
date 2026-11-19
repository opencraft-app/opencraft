import { useEffect, useRef, useState } from "react";
import { SettingsButton, SettingsTextInput, SettingsIconButton } from "@opencraft/extension-react";
import {
  SearchIcon,
  RefreshIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PermissionShieldIcon,
  PermissionDocumentIcon,
} from "@opencraft/design-system-web/action-icons";
import { useIntl } from "@opencraft/i18n/react";
import type {
  AssistantMemoryItem,
  AssistantMemoryDocument,
  AssistantMemoryResponse,
  PersonalAssistantBinding,
  PersonalAssistantMethodMap,
} from "@opencraft/appserver-protocol";
import type { ChannelRpc } from "./channel-client";
import { memoryDraft, clearMemoryDrafts, type MemoryDraft } from "./assistant-memory-drafts";
type Params = PersonalAssistantMethodMap["opencraft/personal-assistant/memory"]["params"];
type FileResponse = Extract<AssistantMemoryResponse, { action: "file" }>;
type SourceResponse = Extract<AssistantMemoryResponse, { action: "sources" }>;
const labels = {
  title: "Memory",
  private: "Only you",
  help: "About memory",
  back: "Back to memories",
  documentTitle: "Memory document",
  profileDocument: "Personal profile",
  logDocument: "Dated notes",
  previousValue: "Memory before this edit",
  about: "Your personal assistant’s private memory. Shared and group memory is not included.",
  search: "Search memory",
  all: "All memories",
  profile: "Long-term profile",
  log: "Dated records",
  apply: "Search",
  refresh: "Refresh",
  empty: "No matching memories.",
  loading: "Loading…",
  more: "Load more",
  original: "Original document",
  sources: "Sources",
  correct: "Correct",
  forget: "Forget",
  forgetAbout: "Remove this memory? It will stop being recalled; this does not delete the source conversation.",
  confirm: "Confirm forgetting",
  cancel: "Cancel",
  save: "Save correction",
  effective: "Available for recall",
  note: "Available for recall does not mean injected on every turn. Ordinary paragraphs in source documents may not be recognized as facts.",
  unknown: "Source not recorded",
  explicit: "Explicitly recorded",
  automatic: "Learned from conversation",
  sourceMissing: "The original source is unavailable.",
  moreText: "Continue reading",
  rawAbout: "Read-only Markdown source. Use Correct to change a remembered fact.",
  saved: "Memory updated.",
  forgotten: "Memory forgotten.",
  facts: "Remembered facts",
  documents: "Documents",
  noDocuments: "No memory documents yet.",
  count: "Showing {shown} of {total}",
  total: "{total} memories",
  order: "Most recently updated first",
  fileCount: "{count} recognized facts · {characters} characters",
  newer: "Memory has changed. Your current view and draft have not been replaced.",
  offline:
    "Read-only: the assistant is not running. Browsing works without starting a model; changes require the original runtime.",
  discard: "You have an unsaved correction. Discard it and continue?",
  restored: "Your unsaved correction was restored in this session.",
  draftKept: "Your unsaved correction is kept on this page.",
  originalEvidence:
    "The following messages are the original basis. The current wording was explicitly corrected later; it is not a quote from these messages.",
  manualEvidence: "This memory was explicitly recorded or corrected. No original conversation evidence is attached.",
  latest: "Read latest version (keep draft)",
  latestValue: "Latest remembered value",
  adopt: "Use this version as the editing base",
  compare:
    "The memory changed while you were editing. Compare the latest version, then explicitly choose it as your editing base. Your draft is unchanged.",
  missing: "This memory was removed. Your draft is kept, but cannot overwrite a forgotten entry.",
  error: "Memory could not be read. Please retry.",
  uncertain:
    "The change has not been confirmed. Keep this page open and retry the same change, or read the latest version.",
  conflict: "The memory was updated elsewhere. Your correction was not applied; your draft is kept.",
  snapshot_changed: "The list changed. Refresh to start a new consistent page.",
  document_changed: "The document changed. Reload the original instead of joining different versions.",
  not_provisioned: "The assistant has not created a memory profile yet. Run it once before browsing.",
  busy: "Memory is currently being committed. Please retry shortly.",
  recovery_required:
    "An interrupted memory transaction needs recovery by the original assistant runtime. Nothing has been repaired or overwritten here.",
  storage: "Memory storage could not be safely read. Check the runtime health; this is not an empty memory result.",
  duplicate: "The corrected content already exists as another memory. Your draft is kept.",
  invalid: "The request is invalid. Corrections must contain 1–500 characters.",
  entry_missing: "This memory or document is no longer available.",
  access: "Your assistant binding or authorization changed. Reopen the view after signing in.",
  reloadDocument: "Reload original",
  pending: "Checking…",
} as const;
class MemoryUiError extends Error {
  constructor(readonly kind: string) {
    super(kind);
  }
}
function errorKind(error: unknown, mutation = false) {
  if (error instanceof MemoryUiError) return error.kind;
  const value = error as { code?: string; message?: string };
  if (
    /assistant_changed|denied|UNAUTHORIZED|FORBIDDEN|SESSION_EXPIRED/.test(
      (value.code ?? "") + " " + (value.message ?? ""),
    )
  )
    return "access";
  return mutation ? "uncertain" : "error";
}
export function AssistantMemory({
  rpc,
  binding,
  registerCloseGuard,
}: {
  rpc: ChannelRpc;
  binding: PersonalAssistantBinding;
  registerCloseGuard?: (guard: () => boolean) => () => void;
}) {
  const intl = useIntl(),
    f = (k: keyof typeof labels, values?: Record<string, string | number>) =>
      intl.formatMessage({ id: "people.memory." + k, defaultMessage: labels[k] }, values);
  const [mode, setMode] = useState<"facts" | "documents">("facts"),
    [query, setQuery] = useState(""),
    [kind, setKind] = useState("all");
  const [rows, setRows] = useState<AssistantMemoryItem[]>([]),
    [docs, setDocs] = useState<AssistantMemoryDocument[]>([]),
    [next, setNext] = useState<string | null>(null),
    [total, setTotal] = useState(0),
    [selected, setSelected] = useState<AssistantMemoryItem | null>(null);
  const [loaded, setLoaded] = useState(false),
    [loading, setLoading] = useState(false),
    [saving, setSaving] = useState(false),
    [busy, setBusy] = useState(false),
    [writable, setWritable] = useState(false),
    [suspended, setSuspended] = useState(false),
    [newer, setNewer] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [draft, setDraft] = useState<MemoryDraft | null>(null),
    [latest, setLatest] = useState<AssistantMemoryItem | null>(null),
    [removed, setRemoved] = useState(false),
    [confirm, setConfirm] = useState(false);
  const [file, setFile] = useState<FileResponse | null>(null),
    [source, setSource] = useState<SourceResponse | null>(null);
  const life = useRef<AbortController | null>(null),
    listEpoch = useRef(0),
    connected = useRef(false),
    detailEpoch = useRef(0),
    version = useRef(""),
    criteria = useRef({
      mode: "facts" as "facts" | "documents",
      query: "",
      kind: "all",
    }),
    draftRef = useRef<MemoryDraft | null>(null),
    mutationBusy = useRef(false),
    mutationRequest = useRef<{ signature: string; requestId: string } | null>(null),
    discarded = useRef(false);
  draftRef.current = draft;
  const dirty = !!draft && draft.value !== draft.base.value;
  function storeDraft(value: MemoryDraft | null) {
    draftRef.current = value;
    setDraft(value);
    if (connected.current && value && value.value !== value.base.value) memoryDraft(rpc, binding, value);
    else memoryDraft(rpc, binding, null);
  }
  function clearDetails() {
    detailEpoch.current++;
    setSelected(null);
    setFile(null);
    setSource(null);
    setConfirm(false);
    setLatest(null);
    setRemoved(false);
    setBusy(false);
  }
  function allowDiscard() {
    const d = draftRef.current;
    if (d && d.value !== d.base.value && !window.confirm(f("discard"))) return false;
    discarded.current = true;
    storeDraft(null);
    return true;
  }
  function fail(error: unknown, mutation = false) {
    const code = errorKind(error, mutation);
    setError(code);
    if (code === "access") {
      connected.current = false;
      clearMemoryDrafts(rpc);
      storeDraft(null);
      setRows([]);
      setDocs([]);
      clearDetails();
      setLoaded(false);
      setSuspended(true);
    }
    return code;
  }
  async function call(p: Omit<Params, "botId" | "assignmentId">) {
    const c = life.current;
    if (!c) throw new MemoryUiError("access");
    await rpc.connect();
    c.signal.throwIfAborted();
    const response = await rpc.request(
      "opencraft/personal-assistant/memory",
      { ...p, botId: binding.botId, assignmentId: binding.assignmentId },
      c.signal,
    );
    if (response.action === "error") throw new MemoryUiError(response.code);
    return response;
  }
  async function load(more = false, options = criteria.current, restore = false) {
    const c = life.current;
    if (!c) return;
    const epoch = ++listEpoch.current;
    setLoading(true);
    setError("");
    if (!more) {
      criteria.current = options;
      clearDetails();
      setNotice("");
      setNext(null);
    }
    try {
      const res = await call(
        options.mode === "facts"
          ? {
              action: "list",
              query: options.query,
              ...(options.kind === "all" ? {} : { kind: options.kind as "profile" | "log" }),
              ...(more && next ? { after: next } : {}),
            }
          : { action: "documents", ...(more && next ? { after: next } : {}) },
      );
      if (c.signal.aborted || epoch !== listEpoch.current) return;
      if (res.action !== "list" && res.action !== "documents") throw new MemoryUiError("error");
      if (res.action === "list") setRows((old) => (more ? [...old, ...res.items] : res.items));
      else setDocs((old) => (more ? [...old, ...res.items] : res.items));
      setTotal(res.total);
      setNext(res.next);
      version.current = res.version;
      setWritable(res.writable);
      setNewer(false);
      connected.current = true;
      setLoaded(true);
      setSuspended(false);
      const saved = restore ? (draftRef.current ?? memoryDraft(rpc, binding)) : null;
      if (saved) {
        const entry = await call({ action: "entry", key: saved.base.key });
        if (c.signal.aborted || epoch !== listEpoch.current) return;
        if (entry.action !== "entry") throw new MemoryUiError("error");
        storeDraft(saved);
        setSelected(saved.base);
        setNotice(f("restored"));
        setRemoved(!entry.item);
        if (entry.item && entry.item.revision !== saved.base.revision) {
          setLatest(entry.item);
          setError("conflict");
        }
      }
    } catch (error) {
      if (!c.signal.aborted && epoch === listEpoch.current) fail(error);
    } finally {
      if (!c.signal.aborted && epoch === listEpoch.current) setLoading(false);
    }
  }
  function refresh() {
    if (!allowDiscard()) return;
    void load(false, { mode, query: query.trim(), kind });
  }
  useEffect(() => {
    const c = new AbortController();
    life.current = c;
    discarded.current = false;
    void load(false, criteria.current, true);
    const off = rpc.onDisconnect(() => {
      if (c.signal.aborted) return;
      listEpoch.current++;
      detailEpoch.current++;
      connected.current = false;
      clearMemoryDrafts(rpc);
      setRows([]);
      setDocs([]);
      clearDetails();
      setLoaded(false);
      setSuspended(true);
      setWritable(false);
      setLoading(false);
      setError("error");
    });
    return () => {
      const d = draftRef.current;
      if (connected.current && !discarded.current && d && d.value !== d.base.value) memoryDraft(rpc, binding, d);
      c.abort();
      off();
      life.current = null;
      listEpoch.current++;
      detailEpoch.current++;
    };
  }, [rpc, binding.botId, binding.assignmentId]);
  useEffect(() => registerCloseGuard?.(() => !mutationBusy.current && allowDiscard()), [registerCloseGuard, intl]);
  useEffect(() => {
    if (!dirty) return;
    const before = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, [dirty]);
  useEffect(() => {
    let pending = false;
    const check = async () => {
      if (pending || document.visibilityState === "hidden" || !life.current || !version.current || mutationBusy.current)
        return;
      pending = true;
      const epoch = listEpoch.current;
      try {
        const res = await call({ action: "status" });
        if (life.current && !life.current.signal.aborted && epoch === listEpoch.current && res.action === "status") {
          if (res.version !== version.current || res.writable !== writable) setNewer(true);
          if (!res.writable) setWritable(false);
        }
      } catch (error) {
        if (errorKind(error) === "access") fail(error);
      } finally {
        pending = false;
      }
    };
    const timer = setInterval(() => void check(), 15000),
      focus = () => void check();
    window.addEventListener("focus", focus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [rpc, binding.botId, binding.assignmentId, writable]);
  function select(row: AssistantMemoryItem) {
    if (row.key === selected?.key) return;
    if (!allowDiscard()) return;
    clearDetails();
    setSelected(row);
    setNotice("");
    setError("");
  }
  function switchMode(value: "facts" | "documents") {
    if (value === mode || !allowDiscard()) return;
    setMode(value);
    void load(false, { mode: value, query: query.trim(), kind });
  }
  async function readDetail(action: "file" | "sources", path?: string, more = false) {
    if (busy) return;
    const c = life.current!,
      epoch = ++detailEpoch.current;
    setBusy(true);
    setError("");
    try {
      const res = await call(
        action === "sources"
          ? { action, key: selected!.key }
          : {
              action,
              path: path ?? selected?.document?.path ?? "profile.md",
              ...(more && file && file.nextOffset !== null ? { offset: file.nextOffset, version: file.version } : {}),
            },
      );
      if (c.signal.aborted || epoch !== detailEpoch.current) return;
      if (res.action === "file") setFile((old) => (more && old ? { ...res, content: old.content + res.content } : res));
      else if (res.action === "sources") setSource(res);
      else throw new MemoryUiError("error");
    } catch (error) {
      if (!c.signal.aborted && epoch === detailEpoch.current) fail(error);
    } finally {
      if (!c.signal.aborted && epoch === detailEpoch.current) setBusy(false);
    }
  }
  async function readLatest() {
    const d = draftRef.current;
    if (!d || busy) return;
    const c = life.current!,
      epoch = ++detailEpoch.current;
    setBusy(true);
    try {
      const res = await call({ action: "entry", key: d.base.key });
      if (c.signal.aborted || epoch !== detailEpoch.current) return;
      if (res.action !== "entry") throw new MemoryUiError("error");
      setRemoved(!res.item);
      setLatest(res.item);
      setWritable(res.writable);
      setError(res.item ? "conflict" : "entry_missing");
    } catch (error) {
      if (!c.signal.aborted && epoch === detailEpoch.current) fail(error);
    } finally {
      if (!c.signal.aborted && epoch === detailEpoch.current) setBusy(false);
    }
  }
  async function change(action: "set" | "forget") {
    const item = action === "set" ? draftRef.current?.base : selected;
    if (!item || mutationBusy.current || !writable || removed || latest) return;
    const c = life.current!,
      value = draftRef.current?.value.trim(),
      signature = JSON.stringify([item.key, item.revision, action, action === "set" ? value : null]);
    let request = draftRef.current?.pending ?? mutationRequest.current;
    if (!request || request.signature !== signature) request = { signature, requestId: crypto.randomUUID() };
    mutationRequest.current = request;
    if (draftRef.current) storeDraft({ ...draftRef.current, pending: request });
    mutationBusy.current = true;
    setSaving(true);
    setError("");
    try {
      const res = await call({
        action,
        key: item.key,
        expectedRevision: item.revision,
        requestId: request.requestId,
        ...(action === "set" ? { value } : {}),
      });
      if (c.signal.aborted) return;
      if (res.action !== action) throw new MemoryUiError("uncertain");
      mutationRequest.current = null;
      storeDraft(null);
      clearDetails();
      await load();
      if (!c.signal.aborted) setNotice(f(action === "set" ? "saved" : "forgotten"));
    } catch (error) {
      if (!c.signal.aborted) fail(error, true);
    } finally {
      mutationBusy.current = false;
      if (!c.signal.aborted) setSaving(false);
    }
  }
  const origin = (r: AssistantMemoryItem) =>
    f(r.origin === "automatic" ? "automatic" : r.origin === "explicit" ? "explicit" : "unknown");
  const hasDetail = !suspended && !!(selected || file);
  const listRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  // Focus follows intentional navigation, not background refreshes or draft updates.
  const selectionKey = selected?.key ?? file?.path ?? "";
  useEffect(() => {
    if (selectionKey) detailRef.current?.focus();
  }, [selectionKey]);
  function backToList() {
    if (!allowDiscard()) return;
    const key = selected?.key ?? file?.path;
    clearDetails();
    requestAnimationFrame(() => {
      const row = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-memory-key]") ?? []).find(
        (el) => el.dataset.memoryKey === key,
      );
      row?.focus();
    });
  }
  return (
    <section className="assistant-memory" data-detail={hasDetail || undefined} aria-label={f("title")}>
      <header className="assistant-memory-header">
        <div className="assistant-memory-heading">
          <h3>{f("title")}</h3>
          <span className="assistant-memory-private">
            <PermissionShieldIcon />
            {f("private")}
          </span>
        </div>
        <SettingsIconButton label={f("refresh")} disabled={saving || loading} onClick={refresh}>
          <RefreshIcon />
        </SettingsIconButton>
      </header>
      <div className="assistant-memory-tabs" role="group" aria-label={f("title")}>
        {(["facts", "documents"] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={mode === value}
            disabled={saving}
            onClick={() => switchMode(value)}
          >
            {f(value)}
          </button>
        ))}
      </div>
      {mode === "facts" ? (
        <form
          className="assistant-memory-toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            refresh();
          }}
        >
          <div className="assistant-memory-search">
            <SettingsTextInput
              aria-label={f("search")}
              placeholder={f("search")}
              maxLength={200}
              value={query}
              disabled={saving}
              onChange={(e) => setQuery(e.target.value)}
            />
            <SettingsIconButton label={f("apply")} type="submit" disabled={saving || loading}>
              <SearchIcon />
            </SettingsIconButton>
          </div>
          <select
            aria-label={f("all")}
            value={kind}
            disabled={saving || loading}
            onChange={(e) => {
              if (!allowDiscard()) return;
              setKind(e.target.value);
              void load(false, { mode, query: query.trim(), kind: e.target.value });
            }}
          >
            {(["all", "profile", "log"] as const).map((k) => (
              <option key={k} value={k}>
                {f(k)}
              </option>
            ))}
          </select>
        </form>
      ) : null}
      <details className="assistant-memory-about">
        <summary>{f("help")}</summary>
        <p>{f("about")}</p>
        <p>{f("note")}</p>
      </details>
      {error ? <p role="alert">{f(error in labels ? (error as keyof typeof labels) : "error")}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {loading ? <p role="status">{f("loading")}</p> : null}
      {busy ? <p role="status">{f("pending")}</p> : null}
      {suspended && dirty ? <p role="status">{f("draftKept")}</p> : null}
      {newer ? (
        <div role="status">
          <p>{f("newer")}</p>
          <SettingsButton
            disabled={saving || loading || busy}
            onClick={() => (draftRef.current ? void readLatest() : refresh())}
          >
            {f(draft ? "latest" : "refresh")}
          </SettingsButton>
        </div>
      ) : null}
      {loaded && !writable ? <p className="assistant-memory-hint">{f("offline")}</p> : null}
      {!suspended ? (
        <>
          {loaded ? (
            <p className="assistant-memory-count">
              {mode === "facts" ? <span>{f("order")}</span> : <span>{f("documents")}</span>}
              {f((mode === "facts" ? rows.length : docs.length) === total ? "total" : "count", {
                shown: mode === "facts" ? rows.length : docs.length,
                total,
              })}
            </p>
          ) : null}
          <div className="assistant-memory-layout">
            <div
              ref={listRef}
              className="assistant-memory-list"
              aria-label={f(mode === "facts" ? "effective" : "documents")}
            >
              {loaded && !loading && !(mode === "facts" ? rows.length : docs.length) && !error ? (
                <div className="assistant-memory-empty">
                  <SearchIcon />
                  <p>{f(mode === "facts" ? "empty" : "noDocuments")}</p>
                </div>
              ) : null}
              {mode === "facts"
                ? rows.map((row) => (
                    <button
                      type="button"
                      key={row.key}
                      data-memory-key={row.key}
                      className="assistant-memory-item"
                      aria-pressed={selected?.key === row.key}
                      disabled={saving || loading}
                      onClick={() => select(row)}
                    >
                      <span className="assistant-memory-row-kind">{f(row.kind)}</span>
                      <span className="assistant-memory-row-value">{row.value}</span>
                      <ChevronRightIcon className="assistant-memory-row-arrow" />
                      <small>
                        {origin(row)}
                        {row.updatedAt > 0
                          ? " · " +
                            intl.formatDate(row.updatedAt, {
                              year: "numeric",
                              month: "short",
                              day: "numeric",
                            })
                          : ""}
                      </small>
                    </button>
                  ))
                : docs.map((doc) => (
                    <button
                      type="button"
                      key={doc.path}
                      data-memory-key={doc.path}
                      className="assistant-memory-item"
                      aria-pressed={file?.path === doc.path}
                      disabled={loading || busy}
                      onClick={() => {
                        clearDetails();
                        void readDetail("file", doc.path);
                      }}
                    >
                      <span className="assistant-memory-row-kind">
                        <PermissionDocumentIcon />
                        {f(doc.path === "profile.md" ? "profileDocument" : "logDocument")}
                      </span>
                      <span className="assistant-memory-row-value assistant-memory-path">{doc.path}</span>
                      <ChevronRightIcon className="assistant-memory-row-arrow" />
                      <small>
                        {f("fileCount", {
                          count: doc.facts,
                          characters: doc.characters,
                        })}
                      </small>
                    </button>
                  ))}
              {next ? (
                <SettingsButton disabled={loading || saving} onClick={() => void load(true)}>
                  {f("more")}
                </SettingsButton>
              ) : null}
            </div>
            {selected || file ? (
              <article
                className="assistant-memory-detail"
                ref={detailRef}
                tabIndex={-1}
                aria-label={f(selected ? "effective" : "documentTitle")}
              >
                <div className="assistant-memory-detail-nav">
                  <SettingsButton variant="quiet" disabled={saving} onClick={backToList}>
                    <ChevronLeftIcon />
                    {f("back")}
                  </SettingsButton>
                </div>
                {selected ? (
                  <>
                    <h4>{f(removed || latest ? "previousValue" : "effective")}</h4>
                    <p className="assistant-memory-detail-value">{selected.value}</p>
                    <small>
                      {origin(selected)} · v{selected.revision}
                    </small>
                    <div className="assistant-memory-actions">
                      <SettingsButton variant="quiet" disabled={saving || busy} onClick={() => void readDetail("file")}>
                        {f("original")}
                      </SettingsButton>
                      <SettingsButton
                        variant="quiet"
                        disabled={saving || busy}
                        onClick={() => void readDetail("sources")}
                      >
                        {f("sources")}
                      </SettingsButton>
                      <SettingsButton
                        variant="quiet"
                        disabled={saving || !writable}
                        onClick={() => {
                          if (draft) return;
                          storeDraft({ base: selected, value: selected.value });
                          setConfirm(false);
                        }}
                      >
                        {f("correct")}
                      </SettingsButton>
                      <SettingsButton
                        variant="quiet"
                        disabled={saving || !writable}
                        onClick={() => {
                          if (!allowDiscard()) return;
                          setConfirm(true);
                        }}
                      >
                        {f("forget")}
                      </SettingsButton>
                    </div>
                  </>
                ) : null}
                {draft ? (
                  <div className="assistant-memory-edit">
                    <label>
                      {f("correct")}
                      <textarea
                        value={draft.value}
                        maxLength={500}
                        disabled={saving}
                        onChange={(e) => {
                          discarded.current = false;
                          storeDraft({
                            ...draft,
                            value: e.target.value,
                            pending: undefined,
                          });
                        }}
                      />
                    </label>
                    {removed ? <p role="alert">{f("missing")}</p> : null}
                    {latest ? (
                      <div className="assistant-memory-latest">
                        <h4>{f("latestValue")}</h4>
                        <p>{latest.value}</p>
                        <small>v{latest.revision}</small>
                        <p>{f("compare")}</p>
                        <SettingsButton
                          disabled={saving}
                          onClick={() => {
                            storeDraft({
                              ...draft,
                              base: latest,
                              pending: undefined,
                            });
                            setSelected(latest);
                            setLatest(null);
                            setError("");
                            setNewer(false);
                          }}
                        >
                          {f("adopt")}
                        </SettingsButton>
                      </div>
                    ) : null}
                    <div className="assistant-memory-actions">
                      <SettingsButton
                        variant="primary"
                        disabled={saving || !writable || !draft.value.trim() || !dirty || !!latest || removed}
                        loading={saving}
                        onClick={() => void change("set")}
                      >
                        {f("save")}
                      </SettingsButton>
                      <SettingsButton variant="quiet" disabled={saving || busy} onClick={() => void readLatest()}>
                        {f("latest")}
                      </SettingsButton>
                      <SettingsButton
                        variant="quiet"
                        disabled={saving}
                        onClick={() => {
                          if (allowDiscard()) {
                            setLatest(null);
                            setRemoved(false);
                            setError("");
                          }
                        }}
                      >
                        {f("cancel")}
                      </SettingsButton>
                    </div>
                  </div>
                ) : null}
                {confirm ? (
                  <div role="group" aria-label={f("forget")}>
                    <p>{f("forgetAbout")}</p>
                    <div className="assistant-memory-actions">
                      <SettingsButton
                        variant="danger"
                        disabled={saving || !writable}
                        loading={saving}
                        onClick={() => void change("forget")}
                      >
                        {f("confirm")}
                      </SettingsButton>
                      <SettingsButton variant="quiet" disabled={saving} onClick={() => setConfirm(false)}>
                        {f("cancel")}
                      </SettingsButton>
                    </div>
                  </div>
                ) : null}
                {file ? (
                  <section>
                    <h4>{f("original")}</h4>
                    <small>
                      {file.path} · {f("rawAbout")}
                    </small>
                    <pre>{file.content}</pre>
                    {error === "document_changed" ? (
                      <SettingsButton disabled={busy} onClick={() => void readDetail("file", file.path)}>
                        {f("reloadDocument")}
                      </SettingsButton>
                    ) : null}
                    {file.nextOffset !== null ? (
                      <SettingsButton disabled={busy} onClick={() => void readDetail("file", file.path, true)}>
                        {f("moreText")}
                      </SettingsButton>
                    ) : null}
                  </section>
                ) : null}
                {source ? (
                  <section>
                    <h4>{f("sources")}</h4>
                    {source.item.origin === "explicit" ? (
                      <p>{f(source.sources.length ? "originalEvidence" : "manualEvidence")}</p>
                    ) : null}
                    {!source.sources.length && source.item.origin !== "explicit" ? (
                      <p>{f("unknown")}</p>
                    ) : (
                      source.sources.map((s) => (
                        <blockquote key={s.id}>
                          <p>{s.unavailable ? f("sourceMissing") : s.text}</p>
                          {s.at ? <time dateTime={new Date(s.at).toISOString()}>{intl.formatDate(s.at)}</time> : null}
                          <small>
                            {s.id}
                            {s.truncated ? " …" : ""}
                          </small>
                        </blockquote>
                      ))
                    )}
                  </section>
                ) : null}
              </article>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}
