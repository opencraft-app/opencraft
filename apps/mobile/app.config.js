const { configureProduct } = require("./product-entry.cjs");
const stableEventNotice = require("../../packages/react-runtime/NOTICE.json");

module.exports = context => {
  const config = configureProduct(__dirname, context);
  return {
    ...config,
    extra: {
      ...config.extra,
      // Expo embeds this public metadata in the native app manifest. Keep the
      // complete MIT notice even when the JS bundle is minified to bytecode.
      openSourceNotices: [...(config.extra?.openSourceNotices ?? []), stableEventNotice],
    },
  };
};
