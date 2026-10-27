import { basicSetup } from "codemirror";
import { search } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { syntaxHighlighting, HighlightStyle, foldGutter } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "react";

const languageCompartment = new Compartment();
const editabilityCompartment = new Compartment();

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
  editable,
  hasDraft,
  language,
  label,
  onChange,
  value,
}: {
  readonly editable: boolean;
  readonly hasDraft: boolean;
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

  useEffect(() => {
    if (container.current === null) return;
    const editor = new EditorView({
      parent: container.current,
      state: EditorState.create({
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
          EditorView.lineWrapping,
          syntaxHighlighting(codeColors),
          languageCompartment.of([]),
          editabilityCompartment.of(editability(editable)),
          EditorView.contentAttributes.of({ "aria-label": label }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !synchronizing.current) onChangeRef.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    return () => { view.current = null; editor.destroy(); };
    // A file identity change remounts this component from its parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    view.current?.dispatch({ effects: editabilityCompartment.reconfigure(editability(editable)) });
  }, [editable]);

  useEffect(() => {
    let active = true;
    void languageExtension(language).then((extension) => {
      if (active) view.current?.dispatch({ effects: languageCompartment.reconfigure(extension) });
    });
    return () => { active = false; };
  }, [language]);

  useEffect(() => {
    const editor = view.current;
    // While a draft exists, CodeMirror is the immediate document owner. React
    // may commit an earlier keystroke after a newer one; do not replay it over
    // the editor. Clean server refreshes and explicit reverts still sync.
    if (hasDraft || editor === null || editor.state.doc.toString() === value) return;
    synchronizing.current = true;
    try {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
    } finally {
      synchronizing.current = false;
    }
  }, [hasDraft, value]);

  return <div className="workspace-code-editor" ref={container} />;
}
