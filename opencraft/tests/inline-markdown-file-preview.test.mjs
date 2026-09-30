import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const output = await build({
  stdin: { contents: `
    export { createInlineMarkdownFileRenderer, createLinkRenderer } from './packages/chat-render-web/src/renderers/resource-link/resource-link';
    export { resolveStandardChatResource } from '@opencraft/chat-render-react';
    export { WorkbenchPanelService } from '@opencraft/workbench-panels';
    export { Context } from '@deepseek-ai/cordis';
  `, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external',
  loader: { '.scss': 'empty', '.css': 'empty' },
  plugins: [{ name: 'workspace', setup(b) {
    b.onResolve({filter:/^@opencraft\//}, async (args) => ({path:new URL(await import.meta.resolve(args.path)).pathname}));
  }}],
});
const bundled = {exports:{}};
new Function('require', 'exports', 'module', output.outputFiles[0].text)(createRequire(import.meta.url), bundled.exports, bundled);
const exports = bundled.exports;

test('inline Markdown path click opens the existing right-panel resource flow', async () => {
  const dom = new JSDOM('<div id="app"></div>', {url:'http://localhost'});
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  Object.assign(globalThis, {window:dom.window, document:dom.window.document, IS_REACT_ACT_ENVIRONMENT:true});
  const ctx = new exports.Context();
  const fiber = await ctx.plugin(exports.WorkbenchPanelService);
  ctx.workbenchPanels.register({kind:'resource', createTab:({resource})=>({id:resource,resource,kind:'resource',region:'right',title:'file',closable:true,preview:true})});
  const resources = {resolve:exports.resolveStandardChatResource};
  const Inline = exports.createInlineMarkdownFileRenderer(resources);
  const Link = exports.createLinkRenderer(resources);
  const calls=[];
  const context={cwd:'/home/agentuser',externalResourcePolicy:'allow',streaming:false,
    openResource:(target)=>{calls.push(target);ctx.workbenchPanels.open('bot-a:thread-a','resource',{resource:target});}};
  const root=createRoot(document.getElementById('app'));
  const props=(code, overrides={})=>({node:{kind:'inline-code',code},context:{...context,...overrides},renderNodes:()=>null});
  try {
    await act(()=>root.render(React.createElement(Inline,props('/home/agentuser/顺德攻略.md'))));
    assert.equal(calls.length,0,'render must not read or open files');
    const link=document.querySelector('a');
    assert.ok(link,'screenshot path must be actionable');
    await act(()=>link.dispatchEvent(new window.MouseEvent('click',{bubbles:true,cancelable:true})));
    assert.deepEqual(calls,['file:///home/agentuser/顺德攻略.md']);
    const panel=ctx.workbenchPanels.getOwnerSnapshot('bot-a:thread-a');
    assert.equal(panel.right.open,true);
    assert.equal(panel.right.tabs[0].resource,calls[0]);
    assert.equal(ctx.workbenchPanels.getOwnerSnapshot('bot-b:thread-a').right.open,false);
    for(const code of ['README.md','cat /home/agentuser/a.md','https://example.com/a.md','javascript:alert(1)','/tmp/a.md; cat /tmp/b.md']){
      await act(()=>root.render(React.createElement(Inline,props(code))));
      assert.equal(document.querySelector('a'),null,code);
    }
    for(const code of ['./顺德 攻略.MD','../notes.markdown','file:///home/agentuser/a.md','C:\\docs\\a.md']){
      await act(()=>root.render(React.createElement(Inline,props(code))));
      assert.ok(document.querySelector('a'),code);
    }
    await act(()=>root.render(React.createElement(Inline,props('/tmp/a.md',{streaming:true}))));
    assert.equal(document.querySelector('a'),null);
    await act(()=>root.render(React.createElement(Link,{node:{kind:'link',href:'/tmp/actual.md',children:[],title:null},context,
      renderNodes:()=>React.createElement(Inline,props('/tmp/label.md'))})));
    assert.equal(document.querySelectorAll('a').length,1,'explicit links must not contain nested links');
    assert.equal(document.querySelector('a').getAttribute('href'),'file:///tmp/actual.md');
  } finally {
    await act(()=>root.unmount());
    await fiber.dispose();dom.window.close();
    for(const key of ['window','document','IS_REACT_ACT_ENVIRONMENT']){
      if(previous[key])Object.defineProperty(globalThis,key,previous[key]);else delete globalThis[key];
    }
  }
});
