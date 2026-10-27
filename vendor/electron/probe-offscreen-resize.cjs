'use strict';
const {app, BrowserWindow} = require('electron');
const assert = require('node:assert/strict');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('ozone-platform', 'headless');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const deadline = setTimeout(() => { console.error('Offscreen resize probe timed out'); app.exit(1); }, 45000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({width:390,height:640,useContentSize:true,show:true,frame:false,
    webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  const wc = window.webContents;
  wc.on('render-process-gone', () => { console.error('Offscreen renderer exited'); app.exit(1); });
  const paints = new Map();
  wc.on('paint', (_event, _dirty, image) => { const {width,height}=image.getSize();const key=`${width}x${height}`;paints.set(key,(paints.get(key)||0)+1); });
  wc.setFrameRate(30);
  await wc.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><input id="editor" value="中文选择测试"><output id="tick"></output><script>window.probeIdentity={};editor.focus();editor.setSelectionRange(2,4);let i=0;setInterval(()=>tick.textContent=++i,30)</script>'));
  const state = () => wc.executeJavaScript('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,value:editor.value,start:editor.selectionStart,end:editor.selectionEnd,focused:document.activeElement===editor,identity:window.probeIdentity===window.initialIdentity})');
  await wc.executeJavaScript('window.initialIdentity=window.probeIdentity');
  const cases=[];
  for (const [width,height] of [[390,640],[390,440],[390,640],[960,640],[390,640],[640,390],[390,640],[375,667],[430,932],[390,640]]) {
    const key=`${width}x${height}`,before=paints.get(key)||0,start=Date.now();
    window.setContentSize(width,height);
    while ((paints.get(key)||0)<=before) {
      if(Date.now()-start>5000)throw Error('No paint for '+key);
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    const actual=await state();
    assert.deepEqual(actual,{width,height,dpr:1,value:'中文选择测试',start:2,end:4,focused:true,identity:true});
    cases.push({width,height,passed:true,elapsedMs:Date.now()-start});
  }
  console.log(JSON.stringify({offscreenResizeProbePassed:true,versions:process.versions,cases}));
  clearTimeout(deadline);window.destroy();app.exit(0);
}).catch(error=>{console.error(error.stack);app.exit(1)});
