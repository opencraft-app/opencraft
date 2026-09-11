// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
/**
 * HTML 白名单过滤：仅保留 <a href target> 标签，剥掉所有其他标签和属性。
 *
 * 用于过滤七彩石下发的 description 字段，防止 XSS。
 * 允许的标签：仅 <a>。
 * 允许的属性：仅 href、target。
 * 其他所有标签（<script>、<img>、<iframe> 等）和属性（onerror、onclick 等）全部剥除。
 */

/** 允许的标签白名单（小写） */
const ALLOWED_TAGS = new Set(['a']);

/** 允许的属性白名单（小写） */
const ALLOWED_ATTRS = new Set(['href', 'target']);

/**
 * 过滤 HTML 字符串，仅保留白名单内的标签和属性。
 * 转义所有非白名单标签的尖括号，使其以纯文本显示而非执行。
 */
export function sanitizeHtml(html: string): string {
  if (typeof html !== 'string' || !html) return html;

  // 用正则逐标签处理：
  // 1. 匹配开标签 <tag attr="val"> 或闭标签 </tag>
  // 2. 若 tag 在白名单内，只保留白名单属性
  // 3. 否则把整个标签转义为纯文本（&lt;...&gt;）
  return html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (fullMatch, tagName: string, attrs: string) => {
    const lowerTag = tagName.toLowerCase();
    if (!ALLOWED_TAGS.has(lowerTag)) {
      // 非白名单标签：转义尖括号，使其以文本显示
      return fullMatch.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    // 白名单标签：只保留白名单属性
    const keptAttrs: string[] = [];
    const attrRegex = /([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRegex.exec(attrs)) !== null) {
      const attrName = attrMatch[1].toLowerCase();
      const attrValue = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '';
      if (ALLOWED_ATTRS.has(attrName)) {
        // href 用协议白名单（只允许 http/https/mailto/相对路径/#锚点），比黑名单更稳
        if (attrName === 'href') {
          const trimmed = attrValue.trim().toLowerCase();
          // 允许：相对路径（/ ./ ../）、锚点（#）、http/https/mailto
          const isSafe =
            trimmed.startsWith('/') ||
            trimmed.startsWith('#') ||
            trimmed.startsWith('./') ||
            trimmed.startsWith('../') ||
            trimmed.startsWith('http://') ||
            trimmed.startsWith('https://') ||
            trimmed.startsWith('mailto:');
          if (!isSafe) {
            continue;
          }
        }
        // 转义属性值中的双引号和 & ，防止逃逸出属性边界注入事件属性
        const safeValue = attrValue.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
        keptAttrs.push(`${attrName}="${safeValue}"`);
      }
    }
    const isClosing = fullMatch.trim().startsWith('</');
    const attrPart = keptAttrs.length ? ` ${keptAttrs.join(' ')}` : '';
    return isClosing ? `</${lowerTag}>` : `<${lowerTag}${attrPart}>`;
  });
}
