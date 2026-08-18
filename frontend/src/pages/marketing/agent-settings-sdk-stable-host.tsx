import type { ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";

import { useTeaSdkZhHantObserver } from "./tea-sdk-zh-hant-observer";

const SDK_LOADING_SELECTORS = [
  ".lh-std-channel-panel--loading",
  ".lh-std-channel-panel__loader",
  ".lh-std-model-panel__loader",
] as const;

export function isTeaSdkLoading(root: ParentNode): boolean {
  if (SDK_LOADING_SELECTORS.some((selector) => root.querySelector(selector))) {
    const text = root.textContent ?? "";
    return text.includes("加载中");
  }
  return false;
}

export function hasTeaSdkReadyContent(root: ParentNode): boolean {
  if (isTeaSdkLoading(root)) return false;
  const text = (root.textContent ?? "").trim();
  return text.length > 0;
}

function replaceTextNodeContent(root: ParentNode, replacements: Record<string, string>): void {
  const entries = Object.entries(replacements);
  if (entries.length === 0) return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const original = node.nodeValue ?? "";
    const next = entries.reduce(
      (value, [source, replacement]) => value.replaceAll(source, replacement),
      original,
    );
    if (next !== original) {
      node.nodeValue = next;
    }
    node = walker.nextNode();
  }
}

export function StableTeaSdkPanelHost({
  children,
  textReplacements,
}: {
  children: ReactNode;
  textReplacements?: Record<string, string>;
}) {
  const liveRef = useRef<HTMLDivElement | null>(null);
  const snapshotRef = useRef<string | null>(null);
  const [snapshotHtml, setSnapshotHtml] = useState<string | null>(null);
  const [showSnapshot, setShowSnapshot] = useState(false);

  // zh-Hant 环境下把 SDK 渲染出的简体文案就地转成繁体字形，
  // 并把 SDK 硬编码的 docs 链接加上 /zh-hant/ 前缀。
  useTeaSdkZhHantObserver(liveRef);

  useLayoutEffect(() => {
    const live = liveRef.current;
    if (!live) return;

    const syncSnapshot = () => {
      if (textReplacements) {
        replaceTextNodeContent(live, textReplacements);
      }

      if (hasTeaSdkReadyContent(live)) {
        const html = live.innerHTML;
        snapshotRef.current = html;
        setSnapshotHtml(html);
        setShowSnapshot(false);
        return;
      }

      setShowSnapshot(isTeaSdkLoading(live) && snapshotRef.current !== null);
    };

    syncSnapshot();

    const observer = new MutationObserver(syncSnapshot);
    observer.observe(live, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    });

    return () => observer.disconnect();
  }, [textReplacements]);

  return (
    <div className="relative" data-tea-sdk-stable-host>
      <div
        ref={liveRef}
        aria-hidden={showSnapshot}
        style={showSnapshot ? { display: "none" } : undefined}
      >
        {children}
      </div>
      {showSnapshot && snapshotHtml ? (
        <div
          aria-hidden="true"
          data-testid="tea-sdk-stable-snapshot"
          data-tea-sdk-stable-snapshot
          dangerouslySetInnerHTML={{ __html: snapshotHtml }}
        />
      ) : null}
    </div>
  );
}
