import {forwardRef} from "react";

import {LexicalComposerCore} from "./lexical-composer-core";
import type {
  ComposerEditorHandle,
  ComposerEditorProps,
} from "./composer-editor.types";

export const ComposerEditor = forwardRef<ComposerEditorHandle, ComposerEditorProps>(
  function ComposerEditor(props, ref) {
    return <LexicalComposerCore {...props} ref={ref} />;
  },
);
