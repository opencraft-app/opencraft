import { useEffect } from "react";
/** Cancel pending presentation before a demand-loaded module can admit a stale dialog. */
export function PendingPreview({onClose}:{readonly onClose:()=>void}) {
  useEffect(()=>{const cancel=(event:KeyboardEvent)=>{if(event.key==="Escape"&&!event.isComposing&&event.keyCode!==229){event.preventDefault();event.stopPropagation();onClose();}};window.addEventListener("keydown",cancel,true);return()=>window.removeEventListener("keydown",cancel,true);},[onClose]);return null;
}
