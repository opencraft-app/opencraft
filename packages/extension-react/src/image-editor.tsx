import { createContext, type ComponentType } from "react";

/** A trusted editor receives one image and a guarded result port, never a draft/controller. */
export interface ImageEditorProps {
  readonly source: string;
  readonly name: string;
  readonly onCancel: () => void;
  readonly onComplete: (file: File) => boolean;
}

export interface ImageEditorContribution {
  readonly id: string;
  /** Trusted scoped CSS, mounted in the preview presentation root on demand. */
  readonly styles?: string;
  readonly Component: ComponentType<ImageEditorProps>;
}

export const ImageEditorContext = createContext<ImageEditorContribution | null>(null);
