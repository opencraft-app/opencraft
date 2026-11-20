import React, { type ReactNode } from "react";

/** Quiet tinted section glyphs: 1.5px stroke over an ~8% fill of the same hue. */
const glyphs: Record<string, ReactNode> = {
  attention: <><path className="f" d="M6.5 5h11l3 8v4.5A2.5 2.5 0 0 1 18 20H6a2.5 2.5 0 0 1-2.5-2.5V13z" /><path d="M3.5 13h5l1.5 3h4l1.5-3h5" /><circle className="dot" cx="18.5" cy="4.5" r="2.2" /></>,
  pinned: <><path className="f" d="M9 3.5h6l-1 5.5 3.5 4h-11L10 9z" /><path d="M12 13v7.5" /><circle className="dot" cx="18" cy="5" r="2.2" /></>,
  mine: <><rect className="f" x="3.5" y="4.5" width="17" height="15" rx="4" /><circle cx="12" cy="10.5" r="2.4" /><path d="M7.8 16.5c.9-1.8 2.4-2.7 4.2-2.7s3.3.9 4.2 2.7" /></>,
  recent: <><circle className="f" cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  scheduled: <><rect className="f" x="3.5" y="5" width="17" height="15" rx="4" /><path d="M3.5 10h17M8 3v4M16 3v4" /></>,
};

export function SidebarSectionIcon({ section }: { section: string }) {
  const glyph = glyphs[section];
  return glyph ? <svg className="sidebar-section-icon" data-section={section} viewBox="0 0 24 24" aria-hidden="true">{glyph}</svg> : null;
}

export function SidebarEmptyIcon() {
  return <svg className="sidebar-section-icon" data-section="empty" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-4 3v-3H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" strokeDasharray="3 3" />
  </svg>;
}

const faceTints=['#7aa7e8','#e8a07a','#8bc7a0','#c49be0','#e3c46b','#9aa3ad'];
export function PeopleDefaultFaceArtwork({seed,tint}:{seed:string;tint?:string}) {
  let hash=0;for(const ch of seed)hash=(hash*31+ch.codePointAt(0)!)>>>0;
  return <svg className="people-default-face" viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" fill={tint??faceTints[hash%faceTints.length]}/><circle cx="20" cy="16" r="7" fill="#fff" opacity=".85"/><ellipse cx="20" cy="36" rx="12" ry="9" fill="#fff" opacity=".85"/></svg>;
}

export function PeopleEntryGlyph({kind}:{kind:'inbox'|'assistant'}) {
  return <svg className="sidebar-section-icon" data-section={kind} viewBox="0 0 24 24" aria-hidden="true">{kind==='inbox'
    ? <><path className="f" d="M4 13l2.5-7h11L20 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M4 13l2.5-7h11L20 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM4 13h4.5l1 2h5l1-2H20"/></>
    : <><rect className="f" x="4" y="7.5" width="16" height="12" rx="4"/><rect x="4" y="7.5" width="16" height="12" rx="4"/><path d="M12 4v3.5"/><circle className="eye" cx="9.5" cy="13.5" r="1"/><circle className="eye" cx="14.5" cy="13.5" r="1"/></>}</svg>;
}
