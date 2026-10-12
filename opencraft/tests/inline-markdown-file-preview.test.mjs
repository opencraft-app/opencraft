import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const output = await build({
  stdin: { contents: `
    export { createInlineMarkdownFileRenderer, createMediaFileRenderer, createLinkRenderer } from './packages/chat-render-web/src/renderers/resource-link/resource-link';
    export { ChatDocumentCompiler } from './packages/chat-document/src/compiler';
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

test('inline document path click opens the existing right-panel resource flow', async () => {
  const dom = new JSDOM('<div id="app"></div>', {url:'http://localhost'});
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  Object.assign(globalThis, {window:dom.window, document:dom.window.document, IS_REACT_ACT_ENVIRONMENT:true});
  const ctx = new exports.Context();
  const fiber = await ctx.plugin(exports.WorkbenchPanelService);
  ctx.workbenchPanels.register({kind:'resource', createTab:({resource})=>({id:resource,resource,kind:'resource',region:'right',title:'file',closable:true,preview:true})});
  const resources = {resolve:exports.resolveStandardChatResource};
  const Inline = exports.createInlineMarkdownFileRenderer(resources);
  const Media = exports.createMediaFileRenderer(resources);
  const Link = exports.createLinkRenderer(resources);
  const calls=[];
  const context={cwd:'/home/agentuser',externalResourcePolicy:'allow',streaming:false,
    openResource:(target)=>{calls.push(target);ctx.workbenchPanels.open('bot-a:thread-a','resource',{resource:target});}};
  const root=createRoot(document.getElementById('app'));
  const props=(code, overrides={})=>({node:{kind:'inline-code',code},context:{...context,...overrides},renderNodes:()=>null});
  const mediaProps=(value, overrides={})=>({node:{kind:'text',text:value,segments:[{key:'text',text:value,entering:false}]},context:{...context,...overrides},renderNodes:()=>null});
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
    const parsed=new exports.ChatDocumentCompiler().compile('已保存好，文档在这里 👇\nMEDIA:/home/agentuser/国庆江西行作文.md\n标题为《江山如画》');
    const mediaNode=parsed.nodes[0].children.find((node)=>node.kind==='text' && node.text.startsWith('MEDIA:'));
    assert.ok(mediaNode,'the screenshot response must produce a standalone MEDIA text node');
    await act(()=>root.render(React.createElement(Media,mediaProps(mediaNode.text))));
    const mediaLink=document.querySelector('a');
    assert.ok(mediaLink,'Hermes MEDIA Markdown path must be actionable');
    assert.equal(mediaLink.textContent,'/home/agentuser/国庆江西行作文.md');
    assert.equal(calls.length,1,'rendering a MEDIA path must not read or open a file');
    await act(()=>mediaLink.dispatchEvent(new window.MouseEvent('click',{bubbles:true,cancelable:true})));
    assert.deepEqual(calls,['file:///home/agentuser/顺德攻略.md','file:///home/agentuser/国庆江西行作文.md']);
    assert.equal(ctx.workbenchPanels.getOwnerSnapshot('bot-a:thread-a').right.tabs.at(-1).resource,calls.at(-1));
    for (const path of ['/tmp/report.pdf','/tmp/clip.mp4','/tmp/voice.mp3','/tmp/image.png','/tmp/archive.zip','/tmp/no-extension']) {
      await act(()=>root.render(React.createElement(Media,mediaProps('MEDIA:'+path))));
      assert.ok(document.querySelector('a'),path);
      assert.equal(document.querySelector('a').getAttribute('href'),'file://'+path);
    }
    for (const [value, target] of [['MEDIA:report.pdf','file:///home/agentuser/report.pdf'],['MEDIA:assets/clip.webm','file:///home/agentuser/assets/clip.webm'],['MEDIA:"/tmp/未知 文件.xyz"','file:///tmp/未知 文件.xyz'],['MEDIA:https://example.com/a.pdf','https://example.com/a.pdf']]) {
      await act(()=>root.render(React.createElement(Media,mediaProps(value))));
      assert.equal(document.querySelector('a')?.getAttribute('href'),target,value);
    }
    await act(()=>root.render(React.createElement(Media,mediaProps('MEDIA:https://example.com/a.pdf',{externalResourcePolicy:'restricted'}))));
    assert.equal(document.querySelector('a'),null,'MEDIA must preserve external resource restrictions');
    const inlineMediaParsed=new exports.ChatDocumentCompiler().compile('`MEDIA:/home/agentuser/国庆江西行作文.md`');
    const inlineMediaNode=inlineMediaParsed.nodes[0].children.find((node)=>node.kind==='inline-code');
    assert.ok(inlineMediaNode,'backticked MEDIA path must parse as inline code');
    await act(()=>root.render(React.createElement(Inline,{node:inlineMediaNode,context,renderNodes:()=>null})));
    const inlineMediaLink=document.querySelector('a');
    assert.ok(inlineMediaLink,'backticked MEDIA Markdown path must be actionable');
    assert.equal(inlineMediaLink.textContent,'MEDIA:/home/agentuser/国庆江西行作文.md');
    assert.equal(inlineMediaLink.getAttribute('href'),'file:///home/agentuser/国庆江西行作文.md');
    assert.equal(calls.length,2,'rendering inline MEDIA must not read or open a file');
    await act(()=>inlineMediaLink.dispatchEvent(new window.MouseEvent('click',{bubbles:true,cancelable:true})));
    assert.equal(calls.at(-1),'file:///home/agentuser/国庆江西行作文.md');
    assert.equal(ctx.workbenchPanels.getOwnerSnapshot('bot-a:thread-a').right.tabs.at(-1).resource,calls.at(-1));
    for(const value of ['MEDIA:javascript:alert(1)','MEDIA://example.com/a.md',
      'MEDIA:/tmp/a.md; cat /tmp/b.md','See MEDIA:/tmp/a.md','MEDIA:/tmp/a.md and more']){
      await act(()=>root.render(React.createElement(Media,mediaProps(value))));
      assert.equal(document.querySelector('a'),null,value);
      assert.equal(document.getElementById('app').textContent,value);
    }
    await act(()=>root.render(React.createElement(Media,mediaProps('MEDIA:/tmp/a.md',{streaming:true}))));
    assert.equal(document.querySelector('a'),null,'streaming MEDIA paths remain inert');
    for(const code of ['README.md','report.html','cat /home/agentuser/a.md','cat /home/agentuser/a.html','https://example.com/a.md','javascript:alert(1)','/tmp/a.md; cat /tmp/b.md']){
      await act(()=>root.render(React.createElement(Inline,props(code))));
      assert.equal(document.querySelector('a'),null,code);
    }
    for(const code of ['MEDIA:javascript:alert(1)','MEDIA://example.com/a.md',
      'MEDIA:/tmp/a.md; cat /tmp/b.md']){
      await act(()=>root.render(React.createElement(Inline,props(code))));
      assert.equal(document.querySelector('a'),null,code);
    }
    for(const code of ['./顺德 攻略.MD','../notes.markdown','file:///home/agentuser/a.md','C:\\docs\\a.md']){
      await act(()=>root.render(React.createElement(Inline,props(code))));
      assert.ok(document.querySelector('a'),code);
    }
    await act(()=>root.render(React.createElement(Inline,props('/tmp/a.md',{streaming:true}))));
    assert.equal(document.querySelector('a'),null);
    await act(()=>root.render(React.createElement(Inline,props('/tmp/a.html',{streaming:true}))));
    assert.equal(document.querySelector('a'),null);
    await act(()=>root.render(React.createElement(Inline,props('MEDIA:/tmp/a.md',{streaming:true}))));
    assert.equal(document.querySelector('a'),null,'streaming inline MEDIA remains inert');
    await act(()=>root.render(React.createElement(Link,{node:{kind:'link',href:'/tmp/actual.md',children:[],title:null},context,
      renderNodes:()=>React.createElement(Inline,props('/tmp/label.md'))})));
    assert.equal(document.querySelectorAll('a').length,1,'explicit links must not contain nested links');
    assert.equal(document.querySelector('a').getAttribute('href'),'file:///tmp/actual.md');
    await act(()=>root.render(React.createElement(Link,{node:{kind:'link',href:'/tmp/actual.md',children:[],title:null},context,
      renderNodes:()=>React.createElement(Inline,props('MEDIA:/tmp/label.md'))})));
    assert.equal(document.querySelectorAll('a').length,1,'inline MEDIA inside an explicit link must not create nested links');
    await act(()=>root.render(React.createElement(Link,{node:{kind:'link',href:'/tmp/actual.md',children:[],title:null},context,
      renderNodes:()=>React.createElement(Media,mediaProps('MEDIA:/tmp/label.md'))})));
    assert.equal(document.querySelectorAll('a').length,1,'MEDIA path inside an explicit link must not create nested links');
    const htmlPath='/home/agentuser/.hermes/cron/output/wage_report_2026-10-10.html';
    const htmlParsed=new exports.ChatDocumentCompiler().compile(`报告文件：\`${htmlPath}\`。后续每天 cron 会自动按新逻辑跑。`);
    const htmlNode=htmlParsed.nodes[0].children.find((node)=>node.kind==='inline-code');
    assert.equal(htmlNode?.code,htmlPath,'screenshot path must parse as inline code');
    await act(()=>root.render(React.createElement(Inline,{node:htmlNode,context,renderNodes:()=>null})));
    const htmlLink=document.querySelector('a');
    assert.equal(htmlLink?.getAttribute('href'),`file://${htmlPath}`);
    assert.equal(htmlLink?.dataset.chatResourceKind,'file');
    const callCount=calls.length;
    await act(()=>htmlLink.dispatchEvent(new window.MouseEvent('click',{bubbles:true,cancelable:true})));
    assert.equal(calls.length,callCount+1);
    assert.equal(ctx.workbenchPanels.getOwnerSnapshot('bot-a:thread-a').right.tabs.at(-1).resource,`file://${htmlPath}`);
    await act(()=>root.render(React.createElement(Inline,props('/tmp/report.htm'))));
    assert.equal(document.querySelector('a')?.getAttribute('href'),'file:///tmp/report.htm');
  } finally {
    await act(()=>root.unmount());
    await fiber.dispose();dom.window.close();
    for(const key of ['window','document','IS_REACT_ACT_ENVIRONMENT']){
      if(previous[key])Object.defineProperty(globalThis,key,previous[key]);else delete globalThis[key];
    }
  }
});
