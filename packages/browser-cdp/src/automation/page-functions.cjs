'use strict';
const { browserControlAttributesAreSensitive } = require('@opencraft/browser-core/automation-policy');

// Executed in a private CDP world. No page globals, DOM markers or persistent
// bridge are installed. Only serializable, bounded observations leave the world.
function pageAPI(isSensitive) {
  const attributes = element => Object.fromEntries(
    ['type', 'id', 'name', 'autocomplete', 'aria-label', 'placeholder'].map(key => [key, element.getAttribute(key)]));
  const sensitive = element => {
    for (let node = element; node; node = node.parentElement || node.getRootNode()?.host) {
      if (isSensitive(attributes(node))) return true;
    }
    return false;
  };
  const visible = element => {
    const style = getComputedStyle(element);
    return element.isConnected && !element.closest('[hidden],[inert]')
      && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'
      && [...element.getClientRects()].some(rect => rect.width > 0 && rect.height > 0);
  };
  const name = element => (element.getAttribute('aria-label')
    || (element.labels && [...element.labels].map(label => label.textContent).join(' '))
    || element.getAttribute('placeholder') || element.getAttribute('title')
    || ((!element.isContentEditable && !['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)) ? element.textContent : '')
    || element.getAttribute('name') || element.id || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const metadata = element => ({
    tag: element.tagName, type: element.getAttribute('type') || '',
    role: element.getAttribute('role') || ({ A: 'link', BUTTON: 'button', INPUT: 'textbox', TEXTAREA: 'textbox', SELECT: 'combobox' }[element.tagName]) || 'element',
    name: name(element), disabled: !!element.disabled || element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true' || !!element.closest('[inert]'),
    ...(sensitive(element) ? { value: '<browser__redacted_form_control />' }
      : ('value' in element ? { value: String(element.value).slice(0, 2000) } : {})),
  });
  const walk = function* (root) {
    for (const element of root.children || []) {
      yield element;
      if (element.shadowRoot) yield* walk(element.shadowRoot);
      yield* walk(element);
    }
  };
  return {
    viewport() { return { width: innerWidth, height: innerHeight, scale: visualViewport?.scale || 1 }; },
    async rendered() {
      await new Promise(resolve => requestAnimationFrame(resolve));
      await new Promise(resolve => requestAnimationFrame(resolve));
      return null;
    },
    collect(limit) {
      const result = [];
      for (const element of walk(document)) {
        if (element.matches('a[href],button,input,textarea,select,[role],[contenteditable],[tabindex]') && visible(element)) result.push(element);
        if (result.length >= limit) break;
      }
      return result;
    },
    describe() { return metadata(this); },
    describeAll() { return this.map(metadata); },
    check(expected, editing) {
      const actual = metadata(this);
      if (!this.isConnected || ['tag', 'type', 'role', 'name'].some(key => actual[key] !== expected[key])) return 'STALE_REF';
      if (!visible(this) || actual.disabled) return 'ELEMENT_NOT_ACTIONABLE';
      if (editing && sensitive(this)) return 'POLICY_BLOCKED';
      if (editing && (this.readOnly || !(this.isContentEditable || this.tagName === 'TEXTAREA'
        || (this.tagName === 'INPUT' && /^(text|search|url|tel|email|password)?$/.test(this.type))))) return 'ELEMENT_NOT_EDITABLE';
      return null;
    },
    containsHit(hit) {
      let node = hit;
      while (node) {
        if (node === this) return true;
        node = node.parentNode || node.host;
      }
      return false;
    },
    focused() {
      let active = document.activeElement;
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
      return active === this || this.contains(active);
    },
    selectContents() {
      if (this.isContentEditable) {
        const range = document.createRange(); range.selectNodeContents(this);
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      } else this.select();
      return null;
    },
    context(limit, includeSelection) {
      const parts = []; let length = 0;
      function visit(node) {
        if (length >= limit) return;
        if (node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent.replace(/\s+/g, ' ').trim();
          if (text) { parts.push(text.slice(0, limit - length)); length += text.length + 1; }
          return;
        }
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(node.tagName) || !visible(node)) return;
          if (sensitive(node)) { parts.push('<browser__redacted_form_control />'); length += 34; return; }
          if (['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName)) {
            const text = `${name(node)}: ${node.value || ''}`.slice(0, limit - length);
            parts.push(text); length += text.length + 1; return;
          }
        }
        for (const child of (node.shadowRoot || node).childNodes) visit(child);
      }
      if (document.body) visit(document.body);
      let selection = null;
      if (includeSelection) {
        let active = document.activeElement;
        while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
        const selected = getSelection();
        const anchor = selected?.anchorNode?.parentElement, focus = selected?.focusNode?.parentElement;
        const containsSensitive = selected && [...walk(document)].some(element => sensitive(element) && selected.containsNode(element, true));
        if (!containsSensitive && !(active && sensitive(active)) && !(anchor && sensitive(anchor)) && !(focus && sensitive(focus)))
          selection = selected?.toString().slice(0, limit) || null;
      }
      return { url: location.href, title: document.title, selection, content: parts.join('\n').slice(0, limit) };
    },
  };
}

function declaration(method) {
  return `function(...args){const api=(${pageAPI.toString()})(${browserControlAttributesAreSensitive.toString()});return api[${JSON.stringify(method)}].apply(this,args);}`;
}
module.exports = { declaration };
