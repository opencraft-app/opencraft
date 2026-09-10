// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
/**
 * ZhHantScope —— 硬编码 `{ en, zh }` 简体数据的繁体（zh-Hant）就地转换器
 * ──────────────────────────────────────────────────────────────
 * 背景：
 *   mono2 组件文案统一走项目自身 i18n（`@/i18n/t`，中文即 key），繁体由
 *   构建期生成的 `zh-Hant.json` 词条覆盖，与其他页面保持一致，无需运行时转换。
 *
 *   但少数场景（如 `SkillsDemoPanel` 里 `category.label.{ en, zh }`）是
 *   **硬编码的双语数据**，运行时按 `isChinese` 直接取 `.zh` 字段（简体），
 *   不进 i18n 词条。这类数据在繁体环境下只能靠本组件用 OpenCC `cn→hk`
 *   就地把子树内文本节点转成繁体字形。
 *
 * 幂等策略：
 *   - `translated` WeakSet：已转换的 Text 节点跳过再处理
 *   - 仅在 `zh-Hant` 语言下激活；其他语言完全 pass-through（不加载 OpenCC、
 *     不引入包裹 div、不注册 MutationObserver）
 *   - MutationObserver 用 `subtree + characterData + childList` 监听，
 *     捕获后续异步渲染的新节点
 */

import type { ReactNode, RefObject } from "react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { isZhHant } from "../../lib/zh-hant";
import { applyZhHantOverrides } from "../../lib/zh-hant-overrides";

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
        console.error("[zh-hant-scope] OpenCC 加载失败，繁体转换降级为原文：", err);
        converterPromise = null;
        return (text: string) => text;
      });
  }
  return converterPromise;
};

/** 判断字符串是否包含至少一个中日韩汉字 —— 只对含汉字的文本调用转换器 */
const hasHan = (s: string): boolean => /[\u3400-\u9fff]/.test(s);

/**
 * 在 `containerRef` 指向的 DOM 子树内启用 zh-Hant 就地转换。
 * 仅在当前语言为 `zh-Hant` 时激活；其他语言下是完全 no-op（不加载 OpenCC）。
 */
function useZhHantTextObserver(containerRef: RefObject<HTMLElement | null>): void {
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

    /** 把某个子树内所有文本节点里的简体汉字转成繁体（幂等） */
    const walkAndConvert = (node: Node) => {
      if (!convert) return;
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      let current: Node | null = walker.currentNode;
      // 若 node 本身是 Text，也处理
      if (node.nodeType === Node.TEXT_NODE) processText(node as Text);
      while ((current = walker.nextNode())) {
        processText(current as Text);
      }
    };

    let observer: MutationObserver | null = null;

    void loadConverter().then((c) => {
      if (disposed) return;
      convert = c;
      // 首轮全量转换
      walkAndConvert(root);
      // 监听后续变更（异步渲染、Tab 切换等）
      observer = new MutationObserver((records) => {
        for (const rec of records) {
          if (rec.type === "characterData" && rec.target.nodeType === Node.TEXT_NODE) {
            // 文本内容变了：清掉旧记录再处理
            translatedText.delete(rec.target as Text);
            processText(rec.target as Text);
          } else if (rec.type === "childList") {
            rec.addedNodes.forEach((n) => walkAndConvert(n));
          }
        }
      });
      observer.observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    });

    return () => {
      disposed = true;
      observer?.disconnect();
    };
  }, [active, containerRef]);
}

/**
 * 把整段子树包起来，在繁体（zh-Hant）环境下运行时按需将其中的简体文本
 * 转成繁体字形。用于 SDK 面板之外、硬编码 `{ en, zh }` 简体数据的场景
 * （例如 `SkillsDemoPanel` 里的 `category.label.zh`）。
 *
 * 非繁体语言下这个组件是**完全 pass-through**：不额外渲染任何 DOM 节点，
 * 也不注册 MutationObserver，避免污染国内站 / 英文站的 DOM 结构与 CSS 布局。
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
  useZhHantTextObserver(ref);
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
