# styles

Change here when visual spacing, typography, color, or responsive layout changes.

Start with `VISUAL_CONTRACT.md` when deciding whether a visual change belongs in
ChatUI CSS, a renderer, a primitive, or the desktop shell.

Do not:
- Hide business states that render-model should decide.
- Depend on OpenAPI field names.

Depends on:
- CSS Modules

Used by:
- `components`
- `renderers`
- `primitives`
