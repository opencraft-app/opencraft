module.exports = ({ config }) => {
  const androidRelease = process.env.OPENCRAFT_ANDROID_RELEASE === '1';
  const iosRelease = process.env.OPENCRAFT_IOS_RELEASE === '1';
  const requestedEdition = process.env.OPENCRAFT_LIGHTVELA_EDITION;
  if (requestedEdition && requestedEdition !== 'cn' && requestedEdition !== 'intl') {
    throw new Error('OPENCRAFT_LIGHTVELA_EDITION must be cn or intl.');
  }
  const edition = requestedEdition || (androidRelease || iosRelease ? 'cn' : 'intl');
  const releaseIds = edition === 'cn'
    ? { android: 'com.tencent.vela', ios: 'ai.lightvela.vela' }
    : { android: 'com.tencent.vela.intl', ios: 'ai.lightvela.vela.intl' };
  const internationalRelease = edition === 'intl' && (androidRelease || iosRelease);

  return {
    ...config,
    ...(process.env.OPENCRAFT_EXPO_SURFACE === "agents-next" && { experiments: { ...config.experiments, baseUrl: "/__expo-agents" } }),
    name: androidRelease || iosRelease ? edition === 'cn' ? 'LightVela' : 'LightVela International' : config.name,
    scheme: internationalRelease ? 'opencraft-intl' : config.scheme,
    extra: {
      ...config.extra,
      lightvelaRegion: edition,
      lightvelaLoginRedirect: internationalRelease ? 'opencraft-intl://auth/lightvela' : 'opencraft://auth/lightvela',
    },
    ...(androidRelease && {
      android: {
        ...config.android,
        package: releaseIds.android,
        icon: './assets/lightvela-icon.png',
      },
    }),
    ...(iosRelease && {
      ios: {
        ...config.ios,
        bundleIdentifier: releaseIds.ios,
        icon: './assets/lightvela-icon.png',
      },
    }),
  };
};
