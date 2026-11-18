import { basicSetup } from "codemirror";
import { search } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { syntaxHighlighting, HighlightStyle, foldGutter } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { WorkspaceResourceLocation } from "./workspace-resource-model";
import { useEffect, useLayoutEffect, useRef } from "react";

const wrappingCompartment = new Compartment();
const languageCompartment = new Compartment();
const editabilityCompartment = new Compartment();
const callbackCompartment = new Compartment();

const codeColors = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--color-accent-purple)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--color-text-accent)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--color-accent-blue)" },
  { tag: [tags.comment, tags.meta], color: "var(--color-text-tertiary)" },
  { tag: [tags.propertyName, tags.attributeName], color: "var(--color-accent-blue)" },
  { tag: [tags.typeName, tags.className], color: "var(--color-accent-purple)" },
]);

function editability(editable: boolean): Extension {
  return [EditorState.readOnly.of(!editable), EditorView.editable.of(editable)];
}

async function languageExtension(language: string | null): Promise<Extension> {
  if (language === "css") return (await import("@codemirror/lang-css")).css();
  if (["javascript", "jsx", "typescript", "tsx"].includes(language ?? "")) {
    return (await import("@codemirror/lang-javascript")).javascript({
      typescript: language === "typescript" || language === "tsx",
      jsx: language === "jsx" || language === "tsx",
    });
  }
  return [];
}

export function WorkspaceCodeEditor({
  wrapLines = false, editable, viewStates, documentKey, location,
  language,
  label,
  onChange,
  value,
}: {
  readonly wrapLines?: boolean;
  readonly viewStates?: Map<string, unknown>;
  readonly documentKey?: string;
  readonly location?: WorkspaceResourceLocation;
  readonly editable: boolean;
  readonly language: string | null;
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly value: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const synchronizing = useRef(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useLayoutEffect(() => {
    if (container.current === null) return;
    const saved = documentKey ? viewStates?.get(documentKey) as { state: EditorState; top: number; left: number } | undefined : undefined;
    const editor = new EditorView({
      parent: container.current,
      state: saved?.state ?? EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          // Keep native search controls clear of the workspace chat overlay.
          search({ top: true }),
          foldGutter({ markerDOM: (open) => {
            const marker = document.createElement("span");
            marker.className = `ui-control-glyph ui-control-glyph--${open ? "chevron-down" : "chevron-right"}`;
            marker.setAttribute("aria-hidden", "true");
            return marker;
          } }),
          wrappingCompartment.of(wrapLines ? EditorView.lineWrapping : []),
          syntaxHighlighting(codeColors),
          languageCompartment.of([]),
          editabilityCompartment.of(editability(editable)),
          EditorView.contentAttributes.of({ "aria-label": label }),
          callbackCompartment.of(EditorView.updateListener.of((update) => {
            if (update.docChanged && !synchronizing.current) onChangeRef.current(update.state.doc.toString());
          })),
        ],
      }),
    });
    editor.dispatch({ effects: callbackCompartment.reconfigure(EditorView.updateListener.of(update => { if (update.docChanged && !synchronizing.current) onChangeRef.current(update.state.doc.toString()); })) });
    view.current = editor;
    if (saved) { editor.scrollDOM.scrollTop = saved.top; editor.scrollDOM.scrollLeft = saved.left ?? 0; }
    return () => {
      if (documentKey && viewStates) {
        viewStates.delete(documentKey);
        viewStates.set(documentKey, { state: editor.state, top: editor.scrollDOM.scrollTop, left: editor.scrollDOM.scrollLeft });
        while (viewStates.size > 16) viewStates.delete(viewStates.keys().next().value!);
      }
      view.current = null;
      editor.destroy();
    };
    // A file identity change remounts this component from its parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    view.current?.dispatch({ effects: editabilityCompartment.reconfigure(editability(editable)) });
  }, [editable]);

  useLayoutEffect(() => {
    view.current?.dispatch({ effects: wrappingCompartment.reconfigure(wrapLines ? EditorView.lineWrapping : []) });
  }, [wrapLines]);

  useEffect(() => {
    let active = true;
    void languageExtension(language).then((extension) => {
      if (active) view.current?.dispatch({ effects: languageCompartment.reconfigure(extension) });
    });
    return () => { active = false; };
  }, [language]);

  useLayoutEffect(() => {
    const editor = view.current;
    // Synchronize shared document updates without replacing this editor instance.
    if (editor === null || editor.state.doc.toString() === value) return;
    synchronizing.current = true;
    try {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
    } finally {
      synchronizing.current = false;
    }
  }, [value]);

  useEffect(() => {
    const editor = view.current; if (!editor || !location?.line) return;
    const line = editor.state.doc.line(Math.max(1, Math.min(location.line, editor.state.doc.lines)));
    const anchor = Math.min(line.to, line.from + Math.max(0, (location.column ?? 1) - 1));
    editor.dispatch({ selection: { anchor }, effects: EditorView.scrollIntoView(anchor, { y: "center" }) });
  }, [location]);

  return <div className="workspace-code-editor" ref={container} />;
}
