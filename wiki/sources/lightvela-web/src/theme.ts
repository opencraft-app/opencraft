import type { CSSProperties } from 'react';
import themeData from './data/theme.json';
import type { Attributes, Theme } from './types';

export const theme = themeData as Theme;
export const color = (token?: string) => token ? theme.colors[token] ?? token : undefined;
export const numeric = (value: string | undefined, fallback = 0) => value === undefined ? fallback : Number(value);

export function textStyle(attrs: Attributes): CSSProperties {
  const font = attrs.font ? theme.fonts[attrs.font] : undefined;
  return {
    fontFamily: font?.family ?? (attrs.font ? attrs.font : undefined),
    fontSize: attrs.size ? Number(attrs.size) : font?.size,
    color: color(attrs.color),
    textAlign: attrs.align as CSSProperties['textAlign'],
    lineHeight: attrs['line-height'] ? Number(attrs['line-height']) : undefined,
    backgroundColor: color(attrs.highlight),
    marginTop: attrs['space-before'] ? Number(attrs['space-before']) : undefined,
    marginBottom: attrs['space-after'] ? Number(attrs['space-after']) : undefined,
  };
}
