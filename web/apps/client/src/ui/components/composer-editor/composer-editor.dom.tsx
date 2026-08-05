'use dom';

import type {
  ComposerDocument,
} from "@vela/client-core";
import {useDOMImperativeHandle} from "expo/dom";
import {useRef, type Ref} from "react";

import {LexicalComposerCore} from "./lexical-composer-core";
import type {
  ComposerBridgeValue,
  ComposerEditorAppearance,
  ComposerEditorDomHandle,
  ComposerEditorHandle,
  ComposerEditorSnapshot,
  ComposerMentionInsertion,
  ComposerSuggestionCommand,
} from "./composer-editor.types";

export default function ComposerEditorDom({
  appearanceJson,
  disabled,
  initialDocumentJson,
  onSnapshotJson,
  onSubmitJson,
  onSuggestionCommand,
  placeholder,
  ref,
  suggestionsOpen,
}: {
  appearanceJson: string;
  disabled: boolean;
  initialDocumentJson: string;
  onSnapshotJson(value: string): Promise<void>;
  onSubmitJson(value: string): Promise<void>;
  onSuggestionCommand(value: ComposerSuggestionCommand): Promise<void>;
  placeholder: string;
  ref?: Ref<ComposerEditorDomHandle>;
  suggestionsOpen: boolean;
}) {
  const editorRef = useRef<ComposerEditorHandle>(null);
  const initialDocument = useRef(
    JSON.parse(initialDocumentJson) as ComposerDocument,
  );

  useDOMImperativeHandle(
    ref ?? null,
    () => ({
      focus() {
        editorRef.current?.focus();
      },
      replaceDocumentJson(value: ComposerBridgeValue) {
        editorRef.current?.replaceDocument(
          JSON.parse(bridgeString(value)) as ComposerDocument,
        );
      },
      replaceMentionJson(value: ComposerBridgeValue) {
        editorRef.current?.replaceMention(
          JSON.parse(bridgeString(value)) as ComposerMentionInsertion,
        );
      },
      requestSubmit() {
        editorRef.current?.requestSubmit();
      },
    }),
    [],
  );

  return (
    <>
      <style>{`html, body, #root { box-sizing: border-box; inline-size: 100%; margin: 0; padding: 0; background: transparent; overflow: hidden; }`}</style>
      <LexicalComposerCore
        ref={editorRef}
        appearance={JSON.parse(appearanceJson) as ComposerEditorAppearance}
        disabled={disabled}
        document={initialDocument.current}
        onSnapshotChange={(snapshot: ComposerEditorSnapshot) => {
          void onSnapshotJson(JSON.stringify(snapshot));
        }}
        onSubmit={(snapshot: ComposerEditorSnapshot) => {
          void onSubmitJson(JSON.stringify(snapshot));
        }}
        onSuggestionCommand={(command) => {
          void onSuggestionCommand(command);
        }}
        placeholder={placeholder}
        suggestionsOpen={suggestionsOpen}
      />
    </>
  );
}

function bridgeString(value: ComposerBridgeValue): string {
  if (typeof value !== "string") {
    throw new TypeError("Composer bridge expected a JSON string");
  }
  return value;
}
