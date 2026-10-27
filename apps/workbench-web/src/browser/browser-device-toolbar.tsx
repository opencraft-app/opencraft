import { ChevronDownIcon, RotateIcon as RotateCcw, CloseIcon as X } from "@opencraft/design-system-web/action-icons";
import { useEffect, useRef, useState, type RefObject, type PointerEvent } from "react";

import { browserViewportDeviceProfile, computeBrowserViewportLayout, type BrowserViewportMode } from "@opencraft/browser-core";
import { DEVICE_PRESETS, initializeBrowserViewportPresets, clampViewportWidth, clampViewportHeight } from "./opencraft/viewport-presets.js";
import { computeDragResizeDimensions } from "./opencraft/viewport-resize.js";
initializeBrowserViewportPresets();

type DeviceMode = Exclude<BrowserViewportMode, {type:"responsive"}>;
const labels: Record<string,string> = {
  responsive:"Responsive", "4k":"4K", "laptop-l":"Laptop L", laptop:"Laptop",
  "surface-pro-7":"Surface Pro 7","ipad-air":"iPad Air","ipad-mini":"iPad Mini","surface-duo":"Surface Duo",
  "iphone-15-pro-max":"iPhone 15 Pro Max","pixel-8":"Pixel 8","iphone-15-pro":"iPhone 15 Pro",
  "samsung-galaxy-s24-ultra":"Galaxy S24 Ultra","iphone-se":"iPhone SE",
};

export function BrowserDeviceToolbar({mode,onChange,onClose,zoom,onZoom}:{
  mode:DeviceMode;onChange(mode:DeviceMode):void;onClose():void;zoom:number;onZoom?: (percent:number)=>void;
}) {
  const selection = mode.type === "device" && DEVICE_PRESETS.some(item => item.id === mode.presetId)
    ? mode.presetId : "responsive";
  const editDimension = (axis: "width" | "height", dimension: number) => {
    onChange({...mode, [axis]: dimension, type: "device", presetId: "responsive", deviceProfile: browserViewportDeviceProfile(mode)});
  };
  return (
    <div className="browser-device-toolbar" role="toolbar" aria-label="Device toolbar">
      <label className="browser-device-toolbar__label" htmlFor="browser-device-preset">Dimensions:</label>
      <span className="browser-device-toolbar__select"><select id="browser-device-preset" aria-label="Device preset" value={selection} onChange={event => {
        const preset = DEVICE_PRESETS.find(item => item.id === event.currentTarget.value);
        if (preset) {
          const dimensions = preset.id === "responsive" ? mode : preset;
          onChange({type: "device", presetId: preset.id, width: dimensions.width, height: dimensions.height});
          onZoom?.(100);
        }
        event.currentTarget.blur();
      }}>
        {DEVICE_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{labels[preset.id] ?? preset.id}</option>)}
      </select><ChevronDownIcon size={14} /></span>
      <div className="browser-device-toolbar__dimensions">
        <DimensionInput label="Viewport width" value={mode.width} min={240} onChange={value => editDimension("width", value)}/>
        <span aria-hidden="true">×</span>
        <DimensionInput label="Viewport height" value={mode.height} min={160} onChange={value => editDimension("height", value)}/>
      </div>
      <button type="button" aria-label="Rotate viewport" title="Rotate viewport" onClick={() => {
        onChange({...mode, width: mode.height, height: mode.width});
      }}><RotateCcw size={16}/></button>
      {onZoom ? <span className="browser-device-toolbar__select browser-device-toolbar__zoom"><select aria-label="Browser zoom" value={zoom} onChange={event => {
        onZoom(Number(event.currentTarget.value));
        event.currentTarget.blur();
      }}>
        {[50,75,100,125,150,200].map(percent => <option key={percent} value={percent}>{percent}%</option>)}
      </select><ChevronDownIcon size={14} /></span> : null}
      <button type="button" className="browser-device-toolbar__close" aria-label="Close device toolbar" title="Close device toolbar" onClick={onClose}><X size={14}/></button>
    </div>
  );
}

function DimensionInput({label,value,min,onChange}:{label:string;value:number;min:number;onChange(value:number):void}) {
  // Local text belongs to the focused edit; numeric mode remains parent-owned.
  const [draft, setDraft] = useState<string | null>(null);
  return <input className="browser-device-toolbar__input" aria-label={label} type="number" min={min} max={4096}
    value={draft ?? String(value)}
    onFocus={() => setDraft(String(value))}
    onChange={event => {
      const text = event.currentTarget.value;
      setDraft(text);
      if (text.trim() === "") return;
      const dimension = Number(text);
      if (Number.isFinite(dimension) && dimension >= min && dimension <= 4096) {
        onChange(Math.round(dimension));
      }
    }}
    onBlur={event => {
      const text = event.currentTarget.value;
      if (text.trim() !== "") {
        const dimension = Number(text);
        if (Number.isFinite(dimension)) onChange(Math.max(min, Math.min(4096, Math.round(dimension))));
      }
      setDraft(null);
    }}
    onKeyDown={event => {
      if (event.key === "Enter") event.preventDefault();
      if (event.key === "Enter" || event.key === "Escape") event.currentTarget.blur();
    }}/>
}
type Edge="left"|"right"|"bottom"|"bottom-left"|"bottom-right";
export function BrowserDeviceHandles({mode,slot,onChange}:{mode:DeviceMode;slot:RefObject<HTMLDivElement|null>;onChange(mode:DeviceMode):void}) {
  const [size,setSize]=useState({width:0,height:0});
  const drag=useRef<{pointerId:number;edge:Edge;mode:DeviceMode;x:number;y:number;scale:number}|null>(null);
  // Parent slot refs attach after child layout effects on a fresh panel mount.
  // Subscribe after attachment; do not render hit targets until measured.
  useEffect(()=>{
    if(!slot.current)return;
    const measure=()=>{const r=slot.current!.getBoundingClientRect();setSize({width:r.width,height:r.height});};
    const observer=new ResizeObserver(measure);observer.observe(slot.current);measure();return()=>observer.disconnect();
  },[slot]);
  const layout=computeBrowserViewportLayout({x:0,y:0,...size},mode);
  const bounds=layout.visualBounds;
  const finish=(event:PointerEvent<HTMLButtonElement>,cancel:boolean)=>{
    const current=drag.current;
    if(!current||current.pointerId!==event.pointerId)return;
    drag.current=null;
    if(cancel)onChange(current.mode);
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
  };
  if(size.width<=0||size.height<=0)return null;
  return <div className="browser-device-handles" style={{left:bounds.x,top:bounds.y,width:bounds.width,height:bounds.height}}>
    {(["left","right","bottom","bottom-left","bottom-right"] as const).map(edge=><button key={edge} type="button"
      className={`browser-device-resize browser-device-resize--${edge}`} aria-label={`Resize viewport ${edge}`} title={`Resize viewport ${edge}`}
      onPointerDown={event=>{
        if(event.button!==0||layout.scale<=0)return;
        event.preventDefault();drag.current={pointerId:event.pointerId,edge,mode,x:event.clientX,y:event.clientY,scale:layout.scale};
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event=>{
        const d=drag.current;if(!d||d.pointerId!==event.pointerId)return;
        const dimensions=computeDragResizeDimensions({
          drag:{edge:d.edge,startWidth:d.mode.width,startHeight:d.mode.height,startPointerX:d.x,startPointerY:d.y},
          pointerX:event.clientX,pointerY:event.clientY,scale:d.scale,fitWidth:Math.max(0,size.width-40),fitHeight:Math.max(0,size.height-20),
        });
        onChange({type:"device",presetId:"responsive",deviceProfile:browserViewportDeviceProfile(d.mode),...dimensions});
      }}
      onPointerUp={event=>finish(event,false)} onPointerCancel={event=>finish(event,true)}
      onLostPointerCapture={event=>finish(event,true)}
      onKeyDown={event=>{
        const amount=event.shiftKey?10:1;
        if(event.key==="Escape"&&drag.current){onChange(drag.current.mode);drag.current=null;return;}
        if(!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(event.key))return;
        event.preventDefault();
        const horizontal=edge!=="bottom",vertical=edge!=="left"&&edge!=="right";
        onChange({type:"device",presetId:"responsive",deviceProfile:browserViewportDeviceProfile(mode),
          width:clampViewportWidth(mode.width+(horizontal?(event.key==="ArrowRight"?amount:event.key==="ArrowLeft"?-amount:0):0)),
          height:clampViewportHeight(mode.height+(vertical?(event.key==="ArrowDown"?amount:event.key==="ArrowUp"?-amount:0):0))});
      }}/>)}
  </div>;
}
