import { useId } from "react";

/** Original folder artwork with a thin tab and a softly lit front face. */
export function FileFolderArtwork({ size = 24 }: { readonly size?: number }) {
  const id = useId();
  return (
    <svg
      className="workspace-folder-icon"
      width={size}
      height={size}
      viewBox="0 0 32 28"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={id} x1="16" y1="8" x2="16" y2="25" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--workspace-folder-light)" />
          <stop offset="1" stopColor="var(--workspace-folder-base)" />
        </linearGradient>
      </defs>
      <path
        d="M2 7a2.5 2.5 0 0 1 2.5-2.5h6.8c.7 0 1.2.2 1.7.7l1.5 1.5c.4.4.9.6 1.5.6h11.5A2.5 2.5 0 0 1 30 9.8V22a2.5 2.5 0 0 1-2.5 2.5h-23A2.5 2.5 0 0 1 2 22Z"
        fill="var(--workspace-folder-back)"
      />
      <path
        d="M2 10.5A2.5 2.5 0 0 1 4.5 8h23a2.5 2.5 0 0 1 2.5 2.5V22a2.5 2.5 0 0 1-2.5 2.5h-23A2.5 2.5 0 0 1 2 22Z"
        fill={`url(#${id})`}
      />
    </svg>
  );
}
