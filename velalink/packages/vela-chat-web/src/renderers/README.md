# renderers

Change here when a Web block kind needs different DOM output.

Do not:
- Fetch data here.
- Parse OpenAPI fields here.
- Manage composer state here.
- Own page layout here.

Depends on:
- `adapters`
- `primitives`
- `styles`

Used by:
- `components/conversation`
