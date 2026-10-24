import assert from "node:assert/strict";
import test from "node:test";
import { inspectHoverStyles, inspectHoverHandlers, inspectHoverSource } from "../../scripts/check-hover-policy.mjs";
const styles = source => inspectHoverStyles(source, "fixture.scss");
test("rejects bare and capability-only hover, including nested selectors", () => {
  for (const source of ["a:hover{color:red}", "@media(hover:hover) and (pointer:fine){a:hover{color:red}}", ".a { &:not(:disabled):hover {color:red} }"]) assert.equal(styles(source).length, 1);
});
test("every selector and media alternative must carry its own guard", () => {
  for (const source of [
    '@media(any-hover:hover) and (any-pointer:fine), (min-width:0px){:root:not([data-touch-interaction]) a:hover{color:red}}',
    '@media(any-hover:hover) and (any-pointer:fine){:root:not([data-touch-interaction]),.unguarded {a:hover{color:red}}}',
    '@media(any-hover:hover) and (any-pointer:fine){[data-note=":root:not([data-touch-interaction])"] a:hover{color:red}}',
    'a:not(:not(:hover)){color:red}',
  ]) assert.ok(styles(source).length, source);
  assert.deepEqual(styles('@include controls.hover-capable {a:not(:disabled):hover{color:red}}'), []);
});
test("persistent state remains available without hover capability", () => {
  for (const source of [
    '@include controls.hover-capable {a:hover{color:red} a:focus-visible{color:red}}',
    '@media(any-hover:hover) and (any-pointer:fine){a:focus-visible{color:red}}',
    '@include controls.hover-capable {a:is(:hover,[aria-selected="true"]){color:red}}',
    '@include controls.hover-capable {a:where(:hover,[data-state="open"]){color:red}}',
    '@include controls.hover-capable {a:has(:hover),a:focus-visible{color:red}}',
  ]) assert.ok(styles(source).length, source);
  assert.deepEqual(styles('a[aria-pressed="true"],a:focus-visible{color:red} @include controls.hover-capable {a[aria-pressed="true"]:hover{color:red}}'), []);
});
test("mentions, inverted guards and effects before guards cannot admit touch", () => {
  for (const handler of [
    'event=>{if(event.pointerType === "mouse")return;setOpen(true)}',
    'event=>{console.log(event.pointerType === "mouse");setOpen(true)}',
    'event=>{if(other.pointerType !== "mouse")return;setOpen(true)}',
    'event=>{const value=setOpen(true);if(event.pointerType !== "mouse")return}',
    'event=>{if(setOpen(true) || event.pointerType !== "mouse")return}',
    'event=>{if(event.pointerType !== "mouse"){if(enabled)setOpen(true);return}setOpen(true)}',
    'event=>{if(event.pointerType !== "mouse")return setOpen(true);setOpen(true)}',
  ]) assert.ok(inspectHoverHandlers(`<button onPointerEnter={${handler}}/>`, 'fixture.tsx').length, handler);
  assert.deepEqual(inspectHoverHandlers('<button onPointerOver={event=>{if("mouse" === event.pointerType){setOpen(true)}}}/>', 'fixture.tsx'), []);
  assert.ok(inspectHoverHandlers('<button onMouseMove={()=>setActive(true)}/>', 'fixture.tsx').length);
});
test("pointer movement needs gesture ownership rather than just a down handler", () => {
  const component = body => `<div onPointerDown={begin} onPointerUp={end} onPointerMove={event=>{${body}}}/>`;
  assert.deepEqual(inspectHoverHandlers(component('if(drag.pointerId !== event.pointerId)return;resize(event)'), 'fixture.tsx'), []);
  assert.deepEqual(inspectHoverHandlers(component('if(!owners.has(event.pointerId))return;resize(event)'), 'fixture.tsx'), []);
  assert.ok(inspectHoverHandlers(component('resize(event)'), 'fixture.tsx').length);
  assert.ok(inspectHoverHandlers(component('if(drag.pointerId === event.pointerId)return;resize(event)'), 'fixture.tsx').length);
  assert.ok(inspectHoverHandlers('<div onPointerMove={event=>{if(drag.pointerId !== event.pointerId)return;resize(event)}}/>', 'fixture.tsx').length);
});
test("separate document styles and source locations are scanned", () => {
  for (const file of ['document.html', 'template.ts', 'template.mjs']) {
    const issues = inspectHoverSource('const html = `\n<style>\na:hover {color:red}\n</style>`;', file);
    assert.equal(issues.length, 1, file);
    assert.equal(issues[0].line, 3, file);
  }
});
test("shared guard preserves separate persistent feedback", () => {
  assert.deepEqual(styles('@include controls.hover-capable {a:hover{color:red}} a:focus-visible,a[data-state="open"]{color:red}'), []);
  assert.equal(styles('@include controls.hover-capable {a:hover,a:focus-visible{color:red}}').length, 1);
  assert.equal(styles('@include controls.hover-capable {a:is(:hover,:focus-visible){color:red}}').length, 1);
  assert.deepEqual(styles('@media(any-hover:hover) and (any-pointer:fine){:root:not([data-touch-interaction]) a:hover{color:red}}'), []);
  assert.deepEqual(styles('a:not(:is(:hover,:focus)){color:red}'), []);
});
test("entry handlers distinguish mouse while portal dismissal continuity remains legal", () => {
  assert.equal(inspectHoverHandlers('<button onMouseEnter={() => setOpen(true)}/>', 'fixture.tsx').length, 1);
  assert.equal(inspectHoverHandlers('<button onPointerEnter={() => setOpen(true)}/>', 'fixture.tsx').length, 1);
  assert.deepEqual(inspectHoverHandlers('<button onPointerEnter={event => {if(event.pointerType !== "mouse")return;setOpen(true)}}/>', 'fixture.tsx'), []);
  assert.deepEqual(inspectHoverHandlers('<Menu.Content onMouseEnter={cancelDismiss}/>', 'fixture.tsx'), []);
});
