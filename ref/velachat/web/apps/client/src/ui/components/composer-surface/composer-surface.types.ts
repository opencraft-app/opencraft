import type {ReactNode} from "react";

import type {ConversationSurfaceMode} from "../message-presentation";

export interface ComposerStageProps {
  children: ReactNode;
  overlay?: ReactNode;
  surfaceMode: ConversationSurfaceMode;
}

export interface ComposerMaterialSurfaceProps {
  children: ReactNode;
  disabled?: boolean;
  onPressBackground?(): void;
  surfaceMode: ConversationSurfaceMode;
  testID?: string;
}

export interface ComposerSurfaceLayoutProps {
  attachments?: ReactNode;
  editor: ReactNode;
  error?: ReactNode;
  footer: ReactNode;
  quote?: ReactNode;
}

export interface ComposerFooterProps {
  expandingControls?: ReactNode;
  leadingActions?: ReactNode;
  primaryAction: ReactNode;
  surfaceMode: ConversationSurfaceMode;
}
