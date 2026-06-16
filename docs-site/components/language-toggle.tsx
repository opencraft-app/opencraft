'use client';

import { useEffect, useState } from 'react';

type DocsLanguage = 'en' | 'zh';

const storageKey = 'mono2-docs-language';
const cookieName = 'mono2-docs-language';

function resolveInitialLanguage(): DocsLanguage {
  if (typeof window === 'undefined') return 'zh';

  const stored = window.localStorage.getItem(storageKey);
  if (stored === 'en' || stored === 'zh') return stored;

  return window.navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function LanguageToggle() {
  const [language, setLanguage] = useState<DocsLanguage>('zh');

  useEffect(() => {
    const initial = resolveInitialLanguage();
    setLanguage(initial);
    document.documentElement.dataset.docsLang = initial;
    document.cookie = `${cookieName}=${initial}; path=/; max-age=31536000; SameSite=Lax`;
  }, []);

  function updateLanguage(next: DocsLanguage) {
    setLanguage(next);
    document.documentElement.dataset.docsLang = next;
    window.localStorage.setItem(storageKey, next);
    document.cookie = `${cookieName}=${next}; path=/; max-age=31536000; SameSite=Lax`;
  }

  return (
    <div
      aria-label="Documentation language"
      className="fixed right-4 top-4 z-50 inline-flex rounded-md border border-fd-border bg-fd-background/90 p-0.5 text-xs shadow-sm backdrop-blur"
      role="group"
    >
      <button
        aria-pressed={language === 'en'}
        className="rounded px-2.5 py-1.5 text-fd-muted-foreground transition-colors hover:text-fd-foreground aria-pressed:bg-fd-primary aria-pressed:text-fd-primary-foreground"
        onClick={() => updateLanguage('en')}
        type="button"
      >
        EN
      </button>
      <button
        aria-pressed={language === 'zh'}
        className="rounded px-2.5 py-1.5 text-fd-muted-foreground transition-colors hover:text-fd-foreground aria-pressed:bg-fd-primary aria-pressed:text-fd-primary-foreground"
        onClick={() => updateLanguage('zh')}
        type="button"
      >
        中文
      </button>
    </div>
  );
}
