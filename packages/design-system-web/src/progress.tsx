import React from "react";
import { ProgressIndicatorBase } from './progress-base';

export function ProgressIndicator(props: { readonly className?: string; readonly value?: number; readonly size?: number }) {
  return <ProgressIndicatorBase {...props} variant="ring" />;
}
