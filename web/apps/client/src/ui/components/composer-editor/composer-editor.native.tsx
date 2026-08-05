import type {ComposerEditorSnapshot} from "./composer-editor.types";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  type ComponentProps,
  type ComponentType,
} from "react";
import {View, type ViewStyle} from "react-native";

import ComposerEditorDom from "./composer-editor.dom";
import type {
  ComposerEditorDomHandle,
  ComposerEditorHandle,
  ComposerEditorProps,
  ComposerSuggestionCommand,
} from "./composer-editor.types";

type DomProps = ComponentProps<typeof ComposerEditorDom> & {
  dom?: {
    containerStyle?: ViewStyle;
    matchContents?: boolean;
    scrollEnabled?: boolean;
    style?: ViewStyle;
  };
};

const DomComponent = ComposerEditorDom as ComponentType<DomProps>;

export const ComposerEditor = forwardRef<ComposerEditorHandle, ComposerEditorProps>(
  function ComposerEditor(
    {
      appearance,
      disabled = false,
      document,
      onSnapshotChange,
      onSubmit,
      onSuggestionCommand,
      placeholder,
      suggestionsOpen,
    },
    ref,
  ) {
    const domRef = useRef<ComposerEditorDomHandle>(null);
    const initialDocumentJson = useRef(JSON.stringify(document));
    const lastEmitted = useRef(initialDocumentJson.current);
    const lastApplied = useRef(initialDocumentJson.current);
    const onSnapshotRef = useRef(onSnapshotChange);
    const onSubmitRef = useRef(onSubmit);
    const onSuggestionRef = useRef(onSuggestionCommand);
    onSnapshotRef.current = onSnapshotChange;
    onSubmitRef.current = onSubmit;
    onSuggestionRef.current = onSuggestionCommand;

    const externalJson = JSON.stringify(document);
    useEffect(() => {
      if (externalJson === lastEmitted.current || externalJson === lastApplied.current) return;
      lastApplied.current = externalJson;
      domRef.current?.replaceDocumentJson(externalJson);
    }, [externalJson]);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => domRef.current?.focus(),
        replaceDocument(next) {
          const json = JSON.stringify(next);
          lastApplied.current = json;
          domRef.current?.replaceDocumentJson(json);
        },
        replaceMention: (insertion) =>
          domRef.current?.replaceMentionJson(JSON.stringify(insertion)),
        requestSubmit: () => domRef.current?.requestSubmit(),
      }),
      [],
    );

    const receiveSnapshot = useCallback(async (value: string) => {
      const snapshot = JSON.parse(value) as ComposerEditorSnapshot;
      lastEmitted.current = JSON.stringify(snapshot.document);
      onSnapshotRef.current(snapshot);
    }, []);
    const receiveSubmit = useCallback(async (value: string) => {
      const snapshot = JSON.parse(value) as ComposerEditorSnapshot;
      lastEmitted.current = JSON.stringify(snapshot.document);
      onSubmitRef.current(snapshot);
    }, []);
    const receiveSuggestion = useCallback(async (value: ComposerSuggestionCommand) => {
      onSuggestionRef.current(value);
    }, []);

    return (
      <View
        style={{
          backgroundColor: appearance.backgroundColor,
          maxHeight: appearance.maxHeight,
          minHeight: appearance.minHeight,
          overflow: "hidden",
          width: "100%",
        }}
      >
        <DomComponent
          ref={domRef}
          appearanceJson={JSON.stringify(appearance)}
          disabled={disabled}
          initialDocumentJson={initialDocumentJson.current}
          onSnapshotJson={receiveSnapshot}
          onSubmitJson={receiveSubmit}
          onSuggestionCommand={receiveSuggestion}
          placeholder={placeholder}
          suggestionsOpen={suggestionsOpen}
          dom={{
            containerStyle: {
              maxHeight: appearance.maxHeight,
              minHeight: appearance.minHeight,
              width: "100%",
            },
            matchContents: true,
            scrollEnabled: false,
            style: {
              backgroundColor: appearance.backgroundColor,
              minHeight: appearance.minHeight,
              width: "100%",
            },
          }}
        />
      </View>
    );
  },
);
