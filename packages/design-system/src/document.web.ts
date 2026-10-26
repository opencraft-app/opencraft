import { buildOpenCraftThemeCssProperties } from './theme-engine.js';
import { buttonSizeMetrics } from './button.shared.js';
import { radii, spacing } from './tokens.shared.js';
import { typographyRegistry, typographyRole, type TypographyRoleName } from './typography/typography.shared.js';
import { documentBaseTokens } from './document-tokens.generated.js';

const properties = (mode: 'light' | 'dark') => Object.entries({ ...documentBaseTokens, ...buildOpenCraftThemeCssProperties(mode) })
  .map(([key, value]) => `${key}:${value}`).join(';');
const font = (role: TypographyRoleName) => {
  const value = typographyRole(role, 'web');
  return `${value.fontWeight} ${value.fontSize}px/${value.lineHeight}px ${typographyRegistry.families[value.family].web}`;
};

/** Pre-Workbench documents use the same theme compiler and typography registry.
 * This renderer-free surface needs no client bundle or authenticated resources. */
export const serverDocumentStyles = `
:root{${properties('light')};color-scheme:light;font:${font('body')};background:var(--color-background-surface);color:var(--color-text)}
@media(prefers-color-scheme:dark){:root{${properties('dark')};color-scheme:dark}}
*{box-sizing:border-box}body{margin:0}button,input,select{font:inherit;color:inherit}a{color:inherit}
main{width:min(100%,840px);margin:0 auto;padding:${spacing[8] * 1.5}px ${spacing[8]}px ${spacing[8] * 2}px}
.document-heading{margin-bottom:${spacing[8]}px}.document-brand{display:inline-block;margin-bottom:${spacing[6]}px;color:var(--color-text-secondary);font:${font('metadata')};text-decoration:none}
h1{font:${font('settingsTitle')};margin:0 0 ${spacing[2]}px}h2,summary{font:${font('settingsSectionTitle')};margin:0}p{font:${font('body')};color:var(--color-text-secondary);margin:${spacing[2]}px 0 0}
section{min-width:0;margin:${spacing[8]}px 0 0}section>h2{margin-bottom:${spacing[3]}px}section>p{margin-bottom:${spacing[4]}px}.document-section-heading{display:flex;align-items:center;justify-content:space-between;gap:${spacing[4]}px;margin-bottom:${spacing[3]}px}
.document-card{border:1px solid var(--color-border-default);border-radius:${radii.xxl}px;background:var(--color-background-panel);overflow:hidden}
.document-row{display:flex;align-items:center;justify-content:space-between;gap:${spacing[6]}px;padding:${spacing[4]}px}.document-row+.document-row{border-top:1px solid var(--color-border-subtle)}
.document-copy{min-width:0;flex:1}.document-copy strong{font:${font('settingsLabel')};overflow-wrap:anywhere}.document-copy p{font:${font('metadata')};margin:0}
.document-avatar{display:grid;place-items:center;width:40px;height:40px;flex:0 0 40px;border-radius:${radii.xl}px;background:var(--color-background-button-secondary);font:${font('settingsTitle')};color:var(--color-text-secondary)}
.document-form{padding:${spacing[4]}px}.document-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:${spacing[4]}px}.document-field{min-width:0}.document-field+.document-field{margin-top:${spacing[4]}px}.document-form-grid .document-field{margin:0}
label{display:block;font:${font('settingsLabel')};margin:0 0 ${spacing[2]}px}input,select{width:100%;min-width:0;height:${buttonSizeMetrics.md.height}px;border:1px solid var(--color-border-default);border-radius:${radii.md}px;background:var(--color-background-input);padding:0 ${spacing[3]}px;outline:none;font:${font('input')}}
input::placeholder{color:var(--color-text-tertiary)}.document-inline-field{display:flex;align-items:center;gap:${spacing[2]}px}.document-inline-field input{flex:1}
button,.document-button{display:inline-flex;align-items:center;justify-content:center;gap:${spacing[2]}px;min-height:${buttonSizeMetrics.sm.height}px;border:1px solid var(--color-border-default);border-radius:${radii.md}px;padding:0 ${buttonSizeMetrics.sm.horizontalPadding}px;background:var(--color-background-button-secondary);color:var(--color-text-button-secondary);font:${font('controlCompact')};text-decoration:none;white-space:nowrap;cursor:pointer}
button.primary,.document-button.primary{background:var(--color-background-button-primary);color:var(--color-text-button-primary);border-color:transparent}
.document-button.quiet{background:transparent;border-color:transparent;color:var(--color-text-secondary)}
button:disabled{opacity:.5;cursor:default}button[aria-busy=true]{cursor:progress}.actions{display:flex;align-items:center;gap:${spacing[2]}px;flex-wrap:wrap}.document-form>.actions{margin-top:${spacing[4]}px}
:where(:focus){outline:none}:where(:root[data-keyboard-input] :is(a,button,input,select,summary):focus-visible){outline:2px solid var(--color-border-focus);outline-offset:2px}
@media(hover:hover) and (pointer:fine){:root:not([data-touch-interaction]) button:hover:not(:disabled),:root:not([data-touch-interaction]) .document-button:hover{background:var(--color-background-button-secondary-hover)}:root:not([data-touch-interaction]) :is(button,.document-button).primary:hover:not(:disabled){background:var(--color-background-button-primary-hover)}:root:not([data-touch-interaction]) .document-button.quiet:hover{background:var(--color-background-navigation-hover)}}
button:active:not(:disabled),.document-button:active{background:var(--color-background-navigation-pressed)}:is(button,.document-button).primary:active:not(:disabled){background:var(--color-background-button-primary-active)}
.status{position:fixed;top:${spacing[4]}px;right:${spacing[4]}px;z-index:10;max-width:min(380px,calc(100vw - ${spacing[8]}px));padding:${spacing[3]}px ${spacing[4]}px;border:1px solid var(--color-border-default);border-radius:${radii.lg}px;background:var(--color-background-elevated-primary-opaque);box-shadow:var(--material-glass-shadow);font:${font('metadata')}}.status:empty{display:none}.status.error{color:var(--color-text-danger)}
.member{display:flex;align-items:center;justify-content:space-between;gap:${spacing[4]}px;padding:${spacing[3]}px ${spacing[4]}px}.member+.member{border-top:1px solid var(--color-border-subtle)}.member span{overflow-wrap:anywhere;min-width:0}.member button{flex-shrink:0}
code{font:${font('code')};overflow-wrap:anywhere;user-select:all}.document-invitation:has(code:empty){display:none}.document-invitation{padding:${spacing[3]}px ${spacing[4]}px;border-bottom:1px solid var(--color-border-subtle);margin:0}
details{border-top:1px solid var(--color-border-subtle);padding-top:${spacing[4]}px}summary{cursor:pointer}.document-disclosure{padding-top:${spacing[4]}px}[hidden]{display:none!important}
@media(max-width:600px){main{padding:${spacing[6]}px ${spacing[4]}px}.document-heading{margin-bottom:${spacing[6]}px}.document-row{flex-wrap:wrap;gap:${spacing[3]}px}.document-row>.actions{width:100%}.document-form-grid{grid-template-columns:1fr}.document-inline-field{align-items:stretch;flex-direction:column}.document-inline-field button{align-self:flex-start;min-height:40px}button,.document-button,summary{min-height:44px}.member{flex-wrap:wrap}input,select{font:${font('mobileInput')};min-height:44px}}
@media(forced-colors:active){.document-card,input,select,button,.document-button{border-color:ButtonText}:where(:root[data-keyboard-input] :focus-visible){outline-color:Highlight}}
`;
