import type { ReactNode } from "react";
import "./sidebar-section-icons.scss";

/** Quiet tinted section glyphs: 1.5px stroke over an ~8% fill of the same hue. */
const glyphs: Record<string, ReactNode> = {
  attention: (
    <>
      <path className="f" d="M6.5 5h11l3 8v4.5A2.5 2.5 0 0 1 18 20H6a2.5 2.5 0 0 1-2.5-2.5V13z" />
      <path d="M3.5 13h5l1.5 3h4l1.5-3h5" />
      <circle className="dot" cx="18.5" cy="4.5" r="2.2" />
    </>
  ),
  pinned: (
    <>
      <path className="f" d="M9 3.5h6l-1 5.5 3.5 4h-11L10 9z" />
      <path d="M12 13v7.5" />
      <circle className="dot" cx="18" cy="5" r="2.2" />
    </>
  ),
  mine: (
    <>
      <rect className="f" x="3.5" y="4.5" width="17" height="15" rx="4" />
      <circle cx="12" cy="10.5" r="2.4" />
      <path d="M7.8 16.5c.9-1.8 2.4-2.7 4.2-2.7s3.3.9 4.2 2.7" />
    </>
  ),
  recent: (
    <>
      <circle className="f" cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  scheduled: (
    <>
      <rect className="f" x="3.5" y="5" width="17" height="15" rx="4" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </>
  ),
};

export function SidebarSectionIcon({ section }: { section: string }) {
  const glyph = glyphs[section];
  return glyph ? (
    <svg className="sidebar-section-icon" data-section={section} viewBox="0 0 24 24" aria-hidden="true">
      {glyph}
    </svg>
  ) : null;
}

export function SidebarEmptyIcon() {
  return (
    <svg className="sidebar-section-icon" data-section="empty" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-4 3v-3H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"
        strokeDasharray="3 3"
      />
    </svg>
  );
}
