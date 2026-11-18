import { createElement, useLayoutEffect, useMemo, useRef, type CSSProperties } from 'react';
import { companionScene, companionIdentity, companionPalettes, type CompanionIdentity } from '@opencraft/design-system/companion-artwork';
import { companionPose, companionMotionPolicy, restingCompanionPose, type CompanionActivity, type CompanionPose } from '@opencraft/design-system/companion-motion';
import { observeBudgetedVisual } from './visual-frame-budget';
import './companion-avatar.scss';

/** Identity never changes with activity. Historical/decorative appearances are static by default. */
export function CompanionAvatar({ id, identity = companionIdentity(id), activity = 'rest', theme, size = 32, label, style }:
  { id: string; identity?: CompanionIdentity; activity?: CompanionActivity; theme?: 'light' | 'dark'; size?: number; label?: string; style?: CSSProperties }) {
  const svg = useRef<SVGSVGElement>(null), figure = useRef<SVGGElement>(null), eyes = useRef<SVGGElement>(null);
  const scene = useMemo(() => companionScene(identity), [identity.kind, identity.palette]);
  const palette=companionPalettes[identity.palette], colours=['surface','body','ink'];
  const paint=Object.fromEntries(colours.flatMap((colour,i)=>[['--companion-'+colour+'-light',palette.light[i]],['--companion-'+colour+'-dark',palette.dark[i]]]));
  const phase = useMemo(() => { let n = 0; for (const c of id) n = (Math.imul(n,31) + c.charCodeAt(0)) >>> 0; return n % 628 / 100; }, [id]);
  useLayoutEffect(() => {
    const element=svg.current, body=figure.current, gaze=eyes.current;
    if (!element || !body || !gaze) return;
    const project = (pose: CompanionPose) => {
      body.setAttribute('transform', `translate(0 ${pose.y.toFixed(3)}) translate(40 50) rotate(${pose.rotation.toFixed(3)}) scale(${pose.scaleX.toFixed(4)} ${pose.scaleY.toFixed(4)}) translate(-40 -50)`);
      gaze.setAttribute('transform', `translate(40 ${scene.eyeY}) scale(1 ${pose.eyeScale.toFixed(3)}) translate(-40 ${-scene.eyeY})`);
    };
    const pause = () => { project(restingCompanionPose); element.dataset.motion = 'static'; };
    pause();
    if (activity === 'rest') return;
    let origin: number | undefined;
    return observeBudgetedVisual(element, {
      fps: activity === 'working' ? companionMotionPolicy.workingFps : companionMotionPolicy.waitingFps,
      priority: activity === 'working' ? 2 : 1,
      pause: () => { origin = undefined; pause(); },
      paint: time => {
        origin ??= time; project(companionPose(identity.kind, activity, time-origin, phase)); element.dataset.motion = 'playing';
      },
    });
  }, [id, identity.kind, identity.palette, activity, scene, phase]);
  const shapes = (list: typeof scene.figure) => list.map(({tag,attributes},key) => createElement(tag,{
    ...Object.fromEntries(Object.entries(attributes).map(([k,v])=>{
      const index=palette.light.indexOf(v as never);return [k,index<0?v:`var(--companion-${colours[index]})`];
    })),key,
  }));
  return <svg ref={svg} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80" width={size} height={size} className="ui-companion-avatar" data-companion-theme={theme} data-activity={activity}
    role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} focusable="false" style={{ ...paint, ...style } as CSSProperties}>
    {shapes(scene.surface)}
    <g ref={figure} data-companion-part="figure">{shapes(scene.figure)}<g ref={eyes} data-companion-part="eyes">{shapes(scene.eyes)}</g>{shapes(scene.expression)}</g>
  </svg>;
}
