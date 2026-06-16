'use client';

import { useEffect } from 'react';

function resolveLanguage() {
  try {
    const stored = window.localStorage.getItem('mono2-docs-language');
    if (stored === 'en' || stored === 'zh') return stored;
  } catch {
    // Ignore storage failures and fall back to browser language.
  }

  return window.navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function APIReferenceRedirect() {
  useEffect(() => {
    const lang = resolveLanguage();
    window.location.replace(`/reference/cloudagent?lang=${lang}`);
  }, []);

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="lang-en text-sm text-fd-muted-foreground">Opening the CloudAgent API reference...</p>
      <p className="lang-zh text-sm text-fd-muted-foreground">正在打开 CloudAgent API 参考...</p>
      <a className="text-sm text-fd-primary underline" href="/reference/cloudagent?lang=zh">
        中文
      </a>
      <a className="text-sm text-fd-primary underline" href="/reference/cloudagent?lang=en">
        EN
      </a>
    </main>
  );
}
