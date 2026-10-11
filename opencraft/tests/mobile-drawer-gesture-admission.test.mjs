import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';

// Execute the actual Drawer callbacks with fixture native event/animation ports.
// This verifies admission wiring, not UIKit/WKWebView gesture recognition.
const modules = {
  react: `export const forwardRef=fn=>fn, useCallback=fn=>fn, useMemo=fn=>fn();
    export const useLayoutEffect=fn=>fixture.effects.push(fn);
    export const useState=initial=>[initial,next=>fixture.stateUpdates.push({initial,next})];
    export const useImperativeHandle=(ref,fn)=>{ref.current=fn();};`,
  'react/jsx-runtime': `export const jsx=(type,props)=>({type,props}), jsxs=jsx;`,
  'react-native': `export const StyleSheet={create:value=>value,absoluteFill:{}}, View='View';
    export const Platform={OS:'ios',get isPad(){return fixture.isPad;}};
    export const useWindowDimensions=()=>({width:fixture.width});`,
  'react-native-gesture-handler': `export const Gesture={Pan:()=>fixture.builder('pan'),Tap:()=>fixture.builder('tap')}, GestureDetector='Detector';`,
  'react-native-reanimated': `export default {View:'AnimatedView'}; export const ReduceMotion={System:'system'};
    export const useSharedValue=value=>({value}), useDerivedValue=fn=>({get value(){return fn();}});
    export const useAnimatedStyle=fn=>{fixture.styles.push(fn);return fn();}, useAnimatedProps=fn=>fn(), useAnimatedReaction=()=>{};
    export const cancelAnimation=value=>fixture.cancellations.push(value.value);
    export const withSpring=(target,options,finished)=>{fixture.springs.push({target,finished});return target;};`,
  'react-native-worklets': `export const scheduleOnRN=(fn,...args)=>fn(...args);`,
  'react-native-safe-area-context': `export const useSafeAreaInsets=()=>({top:0,bottom:0,left:0,right:0});`,
  '@opencraft/chat-render-native': `export const NativeChatHorizontalScrollProvider='HorizontalOwner';`,
};
const output = await build({
  entryPoints: ['apps/workbench-expo/src/components/interruptible-mobile-drawer.ios.tsx'],
  bundle: true, write: false, format: 'iife', globalName: 'Drawer', jsx: 'automatic',
  plugins: [{name:'native-event-ports',setup(builder){
    builder.onResolve({filter:/^(react(?:\/jsx-runtime)?|react-native(?:-gesture-handler|-reanimated|-worklets|-safe-area-context)?|@opencraft\/chat-render-native)$/},args=>({path:args.path,namespace:'fixture'}));
    builder.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:modules[args.path]}));
  }}],
});

function mount(width=390, panelAvailable=true, isPad=false) {
  const fixture={width,isPad,effects:[],cancellations:[],springs:[],styles:[],stateUpdates:[],pan:null,ipadPan:null,invalidFailures:0};
  fixture.builder=kind=>{
    const value={config:{},handlers:{}};
    const proxy=new Proxy(value,{get(target,key){
      if(key==='config'||key==='handlers')return target[key];
      return (...args)=>{
        if(String(key).startsWith('on'))target.handlers[key]=args[0];
        else target.config[key]=args.length===1?args[0]:args;
        return proxy;
      };
    }});
    if(kind==='pan'){
      if(!fixture.ipadPan)fixture.ipadPan=value;
      else fixture.pan=value;
    }
    return proxy;
  };
  const context=vm.createContext({fixture});
  vm.runInContext(output.outputFiles[0].text,context);
  const ref={current:null}, samples=[];
  const tree=context.Drawer.InterruptibleMobileDrawer({webGesture:{},children:()=>null,renderNavigationView:()=>null,
    panelSwipe:{available:panelAvailable,open:false,ownerId:'original-owner',onGesture:(owner,gesture)=>samples.push({owner,...gesture})}},ref);
  fixture.effects.forEach(fn=>fn());
  const handlers=fixture.pan.handlers;
  let state='ended', delta={translationX:0,translationY:0,velocityX:0}, activations=0;
  const touches=(x,y,count=1)=>({numberOfTouches:count,allTouches:count?Array.from({length:count},(_,id)=>({id,absoluteX:100+x,absoluteY:200+y})):[]});
  const manager={activate(){
    if(state!=='possible')return;
    state='active';activations++;handlers.onStart(delta);
  },fail(){
    if(state==='ended'){fixture.invalidFailures++;return;}
    if(state!=='possible'&&state!=='active')return;
    if(state==='active')handlers.onEnd(delta,false);
    state='failed';handlers.onFinalize();
  }};
  return {fixture,ref,samples,tree,get activations(){return activations;},
    start(){state='possible';delta={translationX:0,translationY:0,velocityX:0};handlers.onTouchesDown(touches(0,0),manager);},
    move(x,y){
      if(state!=='possible'&&state!=='active')return;
      delta={translationX:x,translationY:y,velocityX:0};handlers.onTouchesMove(touches(x,y),manager);
      // Old offset admission is represented too: missing the manual gate must
      // fail the ambiguous-diagonal regression instead of hiding the fault.
      if(state==='possible'&&!fixture.pan.config.manualActivation&&Math.abs(x)>18&&Math.abs(y)<16)manager.activate();
      if(state==='active')handlers.onUpdate(delta);
    },
    end(order='up-first'){
      if(order==='up-first')handlers.onTouchesUp?.(touches(0,0,0),manager);
      if(state==='active'){handlers.onEnd(delta,true);state='ended';}
      if(order==='end-first')handlers.onTouchesUp?.(touches(0,0,0),manager);
      if(state==='ended')handlers.onFinalize();
    },
    cancel(){manager.fail();},
    extraFinger(){handlers.onTouchesDown(touches(delta.translationX,delta.translationY,2),manager);},
  };
}

test('actual Drawer yields diagonal/vertical scroll; a new contact is eligible immediately',()=>{
  for(const [x,y] of [[20,15],[-20,-15],[3,12]]){
    const drawer=mount();drawer.start();drawer.move(x,y);drawer.move(-80,y);drawer.end();
    assert.equal(drawer.activations,0);assert.equal(drawer.samples.length,0);
    assert.equal(drawer.fixture.cancellations.length,1);assert.equal(drawer.fixture.springs.length,0);
    drawer.start();drawer.move(-25,2);drawer.move(-50,3);drawer.end();
    assert.equal(drawer.activations,1);
    assert.deepEqual(drawer.samples.map(sample=>sample.phase),['start','move','move','end']);
  }
});
test('controls and unavailable/docked no-op intents never enter ACTIVE',()=>{
  const control=mount();control.ref.current.setContentTouchOwned(true);control.start();control.move(30,2);control.end();
  const unavailable=mount(390,false);unavailable.start();unavailable.move(-30,2);unavailable.end();
  const docked=mount(1200,true);docked.start();docked.move(30,2);docked.end();
  for(const drawer of [control,unavailable,docked])assert.equal(drawer.activations,0);
  control.ref.current.setContentTouchOwned(false);control.start();control.move(30,2);control.end();assert.equal(control.activations,1);
});
test('tap/extra fingers release admission; panel cancellation retains its captured owner',()=>{
  const drawer=mount();drawer.start();drawer.move(3,2);drawer.end();assert.equal(drawer.activations,0);
  drawer.start();drawer.move(-30,2);drawer.extraFinger();
  assert.deepEqual(drawer.samples.map(sample=>sample.phase),['start','move','cancel']);
  assert.ok(drawer.samples.every(sample=>sample.owner==='original-owner'&&sample.id===1));
  drawer.start();drawer.move(-25,1);drawer.cancel();assert.equal(drawer.samples.at(-1).id,2);
});
test('navigation keeps ownership after reversal; the next contact can open the other pane',()=>{
  const drawer=mount();drawer.start();drawer.move(25,1);drawer.move(-50,30);drawer.end();
  assert.equal(drawer.activations,1);assert.equal(drawer.samples.length,0);
  drawer.start();drawer.move(-25,1);drawer.end();
  assert.equal(drawer.activations,2);assert.equal(drawer.samples.at(-1).phase,'end');
});
test('wide panel keeps ownership through a late touch-up after END',()=>{
  const drawer=mount(1200,true);
  drawer.start();drawer.move(-28,2);drawer.move(-72,3);drawer.end('end-first');
  assert.equal(drawer.activations,1);
  assert.equal(drawer.fixture.invalidFailures,0);
  assert.deepEqual(drawer.samples.map(sample=>sample.phase),['start','move','move','end']);
  drawer.start();drawer.move(-30,2);drawer.end('up-first');
  assert.equal(drawer.fixture.invalidFailures,0);
  assert.deepEqual(drawer.samples.slice(-3).map(sample=>sample.phase),['start','move','end']);
});
test('iPad wide and split scenes have no full-scene pan detector; iPhone keeps stable nesting',()=>{
  const wide=mount(1200,true,true),split=mount(520,true,true),compact=mount(390,true),phoneWide=mount(900,true);
  assert.equal(wide.tree.props.children[0].type,'Detector');
  assert.equal(split.tree.props.children[0].type,'Detector');
  assert.equal(compact.tree.props.children[0].type,'AnimatedView');
  assert.equal(wide.tree.props.children.at(-1).type,'AnimatedView');
  assert.equal(split.tree.props.children.at(-1).type,'AnimatedView');
  assert.equal(compact.tree.props.children.at(-1).type,'Detector');
  assert.equal(phoneWide.tree.props.children.at(-1).type,'Detector');
});
test('iPad native sidebar left swipe closes only navigation; vertical scroll and short strokes do not',()=>{
  const wide=mount(1200,true,true),split=mount(520,true,true);
  assert.equal(wide.fixture.ipadPan.config.activeOffsetX,-18);
  assert.deepEqual(Array.from(wide.fixture.ipadPan.config.failOffsetY),[-12,12]);
  assert.equal(wide.fixture.styles[0]().left,320);
  wide.fixture.ipadPan.handlers.onStart();
  wide.fixture.ipadPan.handlers.onUpdate({translationX:-160});
  assert.equal(wide.fixture.styles[0]().left,160);
  wide.fixture.ipadPan.handlers.onEnd({translationX:-160,velocityX:-300},true);
  assert.equal(wide.fixture.styles[0]().left,0);
  assert.ok(wide.fixture.stateUpdates.some(update=>update.initial===true&&update.next===false));
  const short=mount(1200,true,true);
  short.fixture.ipadPan.handlers.onStart();
  short.fixture.ipadPan.handlers.onUpdate({translationX:-20});
  short.fixture.ipadPan.handlers.onEnd({translationX:-20,velocityX:0},true);
  assert.equal(short.fixture.styles[0]().left,320);
  short.fixture.ipadPan.handlers.onStart();
  short.fixture.ipadPan.handlers.onUpdate({translationX:-100});
  short.fixture.ipadPan.handlers.onEnd({translationX:-100,velocityX:0},false);
  assert.equal(short.fixture.styles[0]().left,320);
  assert.ok(short.fixture.stateUpdates.every(update=>update.next===true));
  split.ref.current.openDrawer();
  split.fixture.ipadPan.handlers.onStart();
  split.fixture.ipadPan.handlers.onUpdate({translationX:-250});
  split.fixture.ipadPan.handlers.onEnd({translationX:-250,velocityX:-300},true);
  assert.deepEqual(split.fixture.springs.map(spring=>spring.target),[1,0]);
  assert.equal(split.samples.length,0);
});
test('wide navigation button reverses its animation immediately before midpoint',()=>{
  const drawer=mount(1200,true,true);
  drawer.ref.current.closeDrawer();
  drawer.ref.current.toggleNavigation();
  assert.deepEqual(drawer.fixture.springs.map(spring=>spring.target),[0,1]);
  assert.equal(drawer.fixture.styles[0]().left,320);
});
