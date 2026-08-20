/**
 * tea-sdk 面板繁体（zh-Hant）就地转换器
 * ──────────────────────────────────────────────────────────────
 * 背景：
 *   `@tencent/tea-sdk-lightclaw` 只有 `zh`（简体源码）与 `en` 两套词条，
 *   没有繁体。为了兼容 zh-Hant 用户，`i18n-env.ts` 在 zh-Hant 环境下让
 *   SDK 走空词条（渲染简体源码），再由本 hook 在客户端把 SDK 面板容器
 *   内的文本节点用 OpenCC `cn→hk` 就地转成繁体字形。
 *
 *   同时把 SDK 硬编码的 docs 链接 `https://lightvela.ai/docs/xxx` 加上
 *   `/zh-hant/` 前缀，Guide 按钮点进去就是繁体文档。
 *
 * 幂等策略：
 *   - `translated` WeakSet：已转换的 Text/Element 节点跳过再处理
 *   - 转换器仅在 `zh-Hant` 语言下激活；其他语言下不加载 OpenCC
 *   - MutationObserver 用 `subtree + characterData + childList` 监听，
 *     捕获 SDK 后续异步渲染的新节点（例如 QR 码弹窗、Toast）
 */

import type { ReactNode, RefObject } from "react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { isZhHant } from "@/lib/zh-hant";
import { applyZhHantOverrides } from "@/lib/zh-hant-overrides";

/**
 * 懒加载 OpenCC 简→繁转换器。返回 promise 单例，避免重复下载字典。
 * 与 `src/lib/zh-hant.ts` 保持同源实现（cn→hk 香港繁体）。
 */
type Converter = (text: string) => string;
let converterPromise: Promise<Converter> | null = null;
const loadConverter = (): Promise<Converter> => {
  if (!converterPromise) {
    converterPromise = import("opencc-js")
      .then((OpenCC) => {
        const convert = OpenCC.Converter({ from: "cn", to: "hk" });
        return (text: string) => applyZhHantOverrides(convert(text));
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[tea-sdk-zh-hant] OpenCC 加载失败，繁体转换降级为原文：", err);
        converterPromise = null;
        return (text: string) => text;
      });
  }
  return converterPromise;
};

/** 判断字符串是否包含至少一个中日韩汉字 —— 只对含汉字的文本调用转换器 */
const hasHan = (s: string): boolean => /[\u3400-\u9fff]/.test(s);

/** SDK 硬编码的 docs 链接：匹配绝对（含协议）与相对两种形态 */
const DOCS_HREF_ABS_RE = /^(https?:\/\/lightvela\.ai)(\/docs\/)/;
const DOCS_HREF_REL_RE = /^(\/docs\/)/;

/**
 * 给 `<a href="https://lightvela.ai/docs/xxx">` 或 `<a href="/docs/xxx">`
 * 插入 `/zh-hant/` 前缀。若已带任何 lang 前缀则不重复插入。
 */
const localizeDocsHref = (href: string): string | null => {
  if (/\/(zh-hant|zh-sg|en)\/docs\//.test(href)) return null;
  const absMatch = DOCS_HREF_ABS_RE.exec(href);
  if (absMatch) return href.replace(absMatch[0], `${absMatch[1]}/zh-hant${absMatch[2]}`);
  const relMatch = DOCS_HREF_REL_RE.exec(href);
  if (relMatch) return `/zh-hant${href}`;
  return null;
};

/**
 * 在 `containerRef` 指向的 DOM 子树内启用 zh-Hant 就地转换。
 *
 * 仅在当前语言为 `zh-Hant` 时激活；其他语言下是完全 no-op（不加载 OpenCC）。
 *
 * 使用示例：
 * ```tsx
 * const hostRef = useRef<HTMLDivElement>(null);
 * useTeaSdkZhHantObserver(hostRef);
 * return <div ref={hostRef}>{sdkPanel}</div>;
 * ```
 */
export function useTeaSdkZhHantObserver(containerRef: RefObject<HTMLElement | null>): void {
  const { i18n } = useTranslation();
  const active = isZhHant(i18n.resolvedLanguage ?? i18n.language);

  useEffect(() => {
    if (!active) return;
    const root = containerRef.current;
    if (!root) return;

    let disposed = false;
    let convert: Converter | null = null;
    // 记录已转换过的节点，避免重复工作 + 避免因转换触发的 mutation 造成回环
    const translatedText = new WeakSet<Text>();
    const localizedAnchor = new WeakSet<HTMLAnchorElement>();

    /** 把某个子树内所有文本节点里的简体汉字转成繁体（幂等） */
    const walkAndConvert = (node: Node) => {
      if (!convert) return;
      // 元素本身：如果是 anchor，顺便本地化 href
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element;
        if (el.tagName === "A") {
          localizeAnchor(el as HTMLAnchorElement);
        }
        el.querySelectorAll("a").forEach(localizeAnchor);
      }

      // 文本节点：转换字形
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      let current: Node | null = walker.currentNode;
      // 若 root 本身是 Text，也处理
      if (node.nodeType === Node.TEXT_NODE) processText(node as Text);
      while ((current = walker.nextNode())) {
        processText(current as Text);
      }
    };

    const processText = (textNode: Text) => {
      if (!convert) return;
      if (translatedText.has(textNode)) return;
      const data = textNode.data;
      if (!data || !hasHan(data)) {
        translatedText.add(textNode);
        return;
      }
      const converted = convert(data);
      if (converted !== data) {
        textNode.data = converted;
      }
      translatedText.add(textNode);
    };

    const localizeAnchor = (a: HTMLAnchorElement) => {
      if (localizedAnchor.has(a)) return;
      const href = a.getAttribute("href");
      if (!href) return;
      const next = localizeDocsHref(href);
      if (next) a.setAttribute("href", next);
      localizedAnchor.add(a);
    };

    let observer: MutationObserver | null = null;

    void loadConverter().then((c) => {
      if (disposed) return;
      convert = c;
      // 首轮全量转换
      walkAndConvert(root);
      // 监听后续变更（SDK 弹窗、异步渲染、Tab 切换等）
      observer = new MutationObserver((records) => {
        for (const rec of records) {
          if (rec.type === "characterData" && rec.target.nodeType === Node.TEXT_NODE) {
            // 文本内容变了：清掉旧记录再处理
            translatedText.delete(rec.target as Text);
            processText(rec.target as Text);
          } else if (rec.type === "childList") {
            rec.addedNodes.forEach((n) => walkAndConvert(n));
          } else if (rec.type === "attributes" && rec.target.nodeType === Node.ELEMENT_NODE) {
            const el = rec.target as Element;
            if (el.tagName === "A" && rec.attributeName === "href") {
              localizedAnchor.delete(el as HTMLAnchorElement);
              localizeAnchor(el as HTMLAnchorElement);
            }
          }
        }
      });
      observer.observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["href"],
      });
    });

    return () => {
      disposed = true;
      observer?.disconnect();
    };
  }, [active, containerRef]);
}

/**
 * `useTeaSdkZhHantObserver` 的组件封装。
 *
 * 用于 SDK 面板之外的场景（例如 `SkillsDemoPanel` 里硬编码的
 * `{ en, zh }` 简体数据）：把整段子树包起来，运行时按需转成繁体。
 *
 * 非繁体语言下这个组件是**完全 pass-through**：不额外渲染任何 DOM 节点，
 * 也不注册 MutationObserver，避免污染国内站 / 英文站的 DOM 结构与 CSS 布局。
 * 若非繁体时传入 `className`，会开发环境下告警提示（因为该 className
 * 不会被应用到任何节点）。
 */
export function ZhHantScope({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const { i18n } = useTranslation();
  const active = isZhHant(i18n.resolvedLanguage ?? i18n.language);
  const ref = useRef<HTMLDivElement>(null);
  // Hook 内部会用 `active` 判断，因此非繁体下也可安全调用（no-op）
  useTeaSdkZhHantObserver(ref);
  if (!active) {
    // 非繁体：直接返回 children，不引入包裹 div，保持原有 DOM 层级
    return <>{children}</>;
  }
  return (
    <div ref={ref} className={className} data-zh-hant-scope>
      {children}
    </div>
  );
}
