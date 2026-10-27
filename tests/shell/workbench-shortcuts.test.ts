import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { canHandleWorkbenchShortcut, matchesWorkbenchShortcut, shortcutLabel, shortcutAria, type WorkbenchShortcutCommand } from "../../apps/workbench-web/src/workbench-shortcuts";
const key = { key: "o", shiftKey: true, ctrlKey: false, metaKey: false, altKey: false, isComposing: false };
test("common app commands use exact OS modifiers and preserve old aliases", () => {
  const cases: [WorkbenchShortcutCommand, string, boolean][] = [["newChat","O",true],["search","k",false],["settings",",",false],["sidebar","\\",false],["sidebar","b",false],["panel","j",false],["panel","I",true],["composer","c",true],["help","/",false]];
  for (const platform of ["MacIntel","iPad","Win32","Linux x86_64"]) for (const [command,k,shiftKey] of cases) {
    const apple = /Mac|iPad/.test(platform);
    const input = {...key, key:k, shiftKey, metaKey:apple, ctrlKey:!apple};
    assert.equal(matchesWorkbenchShortcut(input,command,platform),true);
    for (const extra of [{altKey:true},{isComposing:true},{shiftKey:!shiftKey},{metaKey:!apple,ctrlKey:apple},{ctrlKey:true,metaKey:true}]) assert.equal(matchesWorkbenchShortcut({...input,...extra},command,platform),false);
  }
  assert.equal(matchesWorkbenchShortcut({...key,key:'k',shiftKey:false,ctrlKey:true},'newChat','Win32'),false);
  assert.equal(shortcutLabel('newChat','MacIntel'),'⌘⇧O');
  assert.equal(shortcutLabel('sidebar','Win32',1),'Ctrl+B');
  assert.equal(shortcutAria('composer','Win32'),'Control+Shift+C');
});
test("composed input ownership preserves overlays, remote input and handled/IME/repeat events", () => {
  const dom = new JSDOM('<body><textarea></textarea></body>');
  const previous = Object.getOwnPropertyDescriptor(globalThis,'Element');
  Object.defineProperty(globalThis,'Element',{configurable:true,value:dom.window.Element});
  try {
    const {document,KeyboardEvent} = dom.window;
    let accepted = false;
    let ownedDialog: string | undefined;
    dom.window.addEventListener('keydown',event => { accepted = canHandleWorkbenchShortcut(event as unknown as globalThis.KeyboardEvent, ownedDialog); });
    const send = (element: Element, options = {}) => {
      accepted=false; element.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,composed:true,cancelable:true,ctrlKey:true,key:'o',shiftKey:true,...options})); return accepted;
    };
    assert.equal(send(document.querySelector('textarea')!),true);
    for (const options of [{repeat:true},{isComposing:true},{keyCode:229}]) assert.equal(send(document.body,options),false);
    const input=document.querySelector('textarea')!;
    input.addEventListener('keydown',event=>event.preventDefault(),{once:true});
    assert.equal(send(input),false);
    for (const attr of ['role="dialog"','role="alertdialog"','role="menu"','role="listbox"','class="terminal-panel"','class="cloud-desktop-panel"','data-disable-workbench-shortcuts="true"']) {
      const host=document.createElement('div'); host.innerHTML=`<div ${attr}><input></div>`;document.body.append(host);
      assert.equal(send(host.querySelector('input')!),false,attr);host.remove();
    }
    const search=document.createElement('div');search.setAttribute('role','dialog');search.className='conversation-search';search.innerHTML='<input><div role="menu"><button>nested</button></div>';document.body.append(search);
    assert.equal(send(search.querySelector('input')!),false);ownedDialog='.conversation-search';
    assert.equal(send(search.querySelector('input')!),true);assert.equal(send(search.querySelector('button')!),false);search.remove();
    const host=document.createElement('div');document.body.append(host);
    const shadow=host.attachShadow({mode:'open'});shadow.innerHTML='<section role="dialog"><textarea></textarea></section>';
    assert.equal(send(shadow.querySelector('textarea')!),false);
  } finally {dom.window.close();if(previous)Object.defineProperty(globalThis,'Element',previous);else Reflect.deleteProperty(globalThis,'Element');}
});
