import { describe, expect, it } from 'vitest';

import { cookiePolicyHomePath, getCookiePolicyChrome } from '../cookie-policy-page';
import {
  getOpenSourceLicensesChrome,
  publicLocaleHomePath as openSourceHomePath,
  translateNoticeText,
} from '../open-source-licenses-page';
import { getPrivacyPolicyChrome, publicLocaleHomePath as privacyHomePath } from '../privacy-policy-page';
import { getTermsOfServiceChrome, localizedLegalPath, localizedLightVelaUrl } from '../terms-of-service-page';

describe('Spanish legal page navigation', () => {
  it('keeps every legal page home link under /es', () => {
    expect(cookiePolicyHomePath('es')).toBe('/es/');
    expect(openSourceHomePath('es')).toBe('/es/');
    expect(privacyHomePath('es')).toBe('/es/');
    expect(localizedLegalPath('/', 'es', true)).toBe('/es/');
  });

  it('keeps internal LightVela legal links under /es', () => {
    expect(localizedLightVelaUrl('https://lightvela.ai/zh-sg/privacy-policy/', 'es', true)).toEqual({
      href: '/es/privacy-policy/',
      label: 'https://lightvela.ai/es/privacy-policy/',
    });
  });

  it('keeps the Open Source legal body in English for Spanish routes', () => {
    const samples = [
      'Open Source Software Licensed under the MIT License:',
      'Terms of the Apache License 2.0:',
      'You may obtain the source code and detailed information about this component at https://example.com.',
      'The project is built on and with the aid of the following open source projects. Credits are given to these projects.',
      'license not found',
    ];

    for (const sample of samples) expect(translateNoticeText(sample, 'es')).toBe(sample);
  });

  it('localizes legal page chrome while keeping the legal body on its English fallback', () => {
    expect(getPrivacyPolicyChrome('es')).toMatchObject({
      backHome: 'Volver al inicio',
      title: 'Política de privacidad',
      updated: 'Última actualización: agosto de 2026',
    });
    expect(getCookiePolicyChrome('es')).toMatchObject({
      backHome: 'Volver al inicio',
      title: 'Política de cookies',
    });
    expect(getTermsOfServiceChrome('es')).toMatchObject({
      backHome: 'Volver al inicio',
      title: 'Términos del servicio',
      note: expect.stringContaining('se ofrece en inglés'),
    });
    expect(getOpenSourceLicensesChrome('es')).toMatchObject({
      backHome: 'Volver al inicio',
      title: 'Aviso de código abierto',
      updated: 'Última actualización: agosto de 2026',
    });
  });
});
