module.exports = ({ config }) => {
  const androidRelease = process.env.OPENCRAFT_ANDROID_RELEASE === '1';
  const iosRelease = process.env.OPENCRAFT_IOS_RELEASE === '1';
  if (!androidRelease && !iosRelease) return config;

  return {
    ...config,
    name: 'LightVela',
    ...(androidRelease && {
      android: {
        ...config.android,
        package: 'com.tencent.vela',
        icon: './assets/lightvela-icon.png',
      },
    }),
    ...(iosRelease && {
      ios: {
        ...config.ios,
        bundleIdentifier: 'ai.lightvela.vela',
        icon: './assets/lightvela-icon.png',
      },
    }),
  };
};
