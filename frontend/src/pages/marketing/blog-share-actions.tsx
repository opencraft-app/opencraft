import { useState } from "react";

import { useT } from "@/i18n/t";

const BLOG_ORIGIN = "https://lightvela.ai";

type BlogShareActionsProps = {
  path: string;
  title: string;
};

type SharePlatform = "X" | "LinkedIn" | "Facebook";

export function canonicalBlogUrl(path: string): string {
  const relativePath = path.startsWith("/") ? path : `/${path}`;
  return new URL(relativePath, BLOG_ORIGIN).toString();
}

function PlatformIcon({ platform }: { platform: SharePlatform }) {
  const pathByPlatform: Record<SharePlatform, string> = {
    X: "M14.234 10.162L22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299l-.929-1.329L3.076 1.56h3.182l5.965 8.532l.929 1.329l7.754 11.09h-3.182z",
    LinkedIn:
      "M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037c-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85c3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.06 2.06 0 1 1 0-4.128a2.06 2.06 0 0 1 0 4.128m1.782 13.019H3.555V9h3.564zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0z",
    Facebook:
      "M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978c.401 0 .955.042 1.468.103a9 9 0 0 1 1.141.195v3.325a9 9 0 0 0-.653-.036a27 27 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.7 1.7 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103l-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647",
  };

  return (
    <svg aria-hidden="true" className="size-4" fill="currentColor" focusable="false" viewBox="0 0 24 24">
      <path d={pathByPlatform[platform]} />
    </svg>
  );
}

export function BlogShareActions({ path, title }: BlogShareActionsProps) {
  const t = useT();
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");
  const shareUrl = canonicalBlogUrl(path);
  const shareText = `${title}\n${shareUrl}`;
  const shareLinks: readonly { label: SharePlatform; href: string }[] = [
    {
      label: "X",
      href: `https://x.com/intent/post?text=${encodeURIComponent(shareText)}`,
    },
    {
      label: "LinkedIn",
      href: `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareUrl)}&title=${encodeURIComponent(title)}`,
    },
    {
      label: "Facebook",
      href: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}&quote=${encodeURIComponent(title)}`,
    },
  ];

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("error");
    }
  }

  return (
    <section aria-labelledby="blog-share-heading" className="mt-12 border-t border-black/10 pt-5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <h2 id="blog-share-heading" className="text-sm font-medium text-black">
          {t("分享")}
        </h2>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2 text-sm text-black/60">
          <button
            type="button"
            className="border-0 px-0 py-1 text-inherit hover:text-black focus-visible:outline-none focus-visible:underline focus-visible:underline-offset-4"
            onClick={copyLink}
          >
            {copyStatus === "copied" ? t("已复制") : t("复制链接")}
          </button>
          {shareLinks.map((shareLink) => (
            <a
              key={shareLink.label}
              href={shareLink.href}
              target="_blank"
              rel="noreferrer"
              aria-label={`${t("分享")} ${shareLink.label}`}
              className="inline-flex size-9 items-center justify-center rounded-md bg-black/[0.04] text-black/60 hover:bg-black/[0.08] hover:text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/30 focus-visible:ring-offset-2"
            >
              <PlatformIcon platform={shareLink.label} />
            </a>
          ))}
        </div>
      </div>
      {copyStatus === "error" ? <p className="mt-3 text-sm text-black/50">{t("复制链接失败")}</p> : null}
    </section>
  );
}
