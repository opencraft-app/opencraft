const stableEventNotice = require("../../packages/react-runtime/NOTICE.json");

const bundleIdentifier = "app.opencraft";
const profileName = "OpenCraft TestFlight CI";

module.exports = ({ config }) => {
  config = {
    ...config,
    extra: {
      ...config.extra,
      // Expo embeds this public metadata in the native app manifest. Keep the
      // complete MIT notice even when the JS bundle is minified to bytecode.
      openSourceNotices: [...(config.extra?.openSourceNotices ?? []), stableEventNotice],
    },
  };
  const androidVersionCode = process.env.OPENCRAFT_ANDROID_VERSION_CODE;
  if (androidVersionCode !== undefined) {
    // Published APKs take a tag-derived code (scripts/release/android-version-code.mjs).
    if (!/^[1-9][0-9]{0,9}$/.test(androidVersionCode) || Number(androidVersionCode) > 2_100_000_000) {
      throw new Error("OPENCRAFT_ANDROID_VERSION_CODE must be a positive integer no greater than 2100000000");
    }
    config = { ...config, android: { ...config.android, versionCode: Number(androidVersionCode) } };
  }
  if (process.env.OPENCRAFT_IOS_EXPORT_METHOD !== "app-store-connect") return config;

  const buildNumber = process.env.OPENCRAFT_IOS_BUILD_NUMBER;
  const teamId = process.env.APPLE_TEAM_ID;
  if (!/^[1-9][0-9]{0,3}$/.test(buildNumber ?? "")) {
    throw new Error("OPENCRAFT_IOS_BUILD_NUMBER must be a positive integer with at most four digits");
  }
  if (!/^[A-Z0-9]{10}$/.test(teamId ?? "")) throw new Error("TestFlight requires a valid APPLE_TEAM_ID");

  const { withXcodeProject } = require("expo/config-plugins");
  return withXcodeProject({ ...config, ios: { ...config.ios, bundleIdentifier, buildNumber } }, (signed) => {
    const project = signed.modResults;
    const { uuid, firstTarget: target } = project.getFirstTarget();
    const attributes = project.getFirstProject().firstProject.attributes;
    const targetAttributes = attributes.TargetAttributes ??= {};
    (targetAttributes[uuid] ??= {}).ProvisioningStyle = "Manual";

    const configurations = project.pbxXCConfigurationList()[target.buildConfigurationList].buildConfigurations;
    const entries = project.pbxXCBuildConfigurationSection();
    for (const { value } of configurations) {
      const configuration = entries[value];
      if (configuration.name !== "Release") continue;
      Object.assign(configuration.buildSettings, {
        CODE_SIGN_IDENTITY: '"Apple Distribution"',
        CODE_SIGN_STYLE: "Manual",
        CURRENT_PROJECT_VERSION: buildNumber,
        DEVELOPMENT_TEAM: teamId,
        PROVISIONING_PROFILE_SPECIFIER: `"${profileName}"`,
      });
    }
    return signed;
  });
};
