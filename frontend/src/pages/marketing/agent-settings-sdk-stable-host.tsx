import type { ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";

const SDK_LOADING_SELECTORS = [
  ".lh-std-channel-panel--loading",
  ".lh-std-channel-panel__loader",
  ".lh-std-model-panel__loader",
] as const;

/**
 * 面板是否处于加载态。
 *
 * 只按 loading class 判断，不再校验文案内容 —— 面板文案已国际化，
 * 英文站 loader 文本是 "Loading..."，早先的 `text.includes("加载中")`
 * 在国际站恒为 false，导致加载态被误判成就绪内容、防闪烁快照完全失效。
 */
export function isTeaSdkLoading(root: ParentNode): boolean {
  return SDK_LOADING_SELECTORS.some((selector) => root.querySelector(selector));
}

export function hasTeaSdkReadyContent(root: ParentNode): boolean {
  if (isTeaSdkLoading(root)) return false;
  const text = (root.textContent ?? "").trim();
  return text.length > 0;
}

export function StableTeaSdkPanelHost({ children }: { children: ReactNode }) {
  const liveRef = useRef<HTMLDivElement | null>(null);
  const snapshotRef = useRef<string | null>(null);
  const [snapshotHtml, setSnapshotHtml] = useState<string | null>(null);
  const [showSnapshot, setShowSnapshot] = useState(false);

  // 面板文案已本地化为 mono2 自身 i18n（`@/i18n/t`），繁体由 `zh-Hant.json`
  // 词条覆盖，与其他页面一致，无需运行时转换。本 host 仅负责在面板内容
  // 短暂回到加载态时用上一帧快照防止闪烁。
  //
  // 依赖数组为空：observer 只在挂载时建立一次。此前无依赖数组，每次渲染都
  // disconnect + 重建，而回调内的 setState 又触发渲染，形成自激循环。
  useLayoutEffect(() => {
    const live = liveRef.current;
    if (!live) return;

    const syncSnapshot = () => {
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
  }, []);

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
