export default {
  manifest: {
    manifestVersion: 1,
    id: "user.craft-hello",
    name: "Craft Hello",
    version: "1.0.0",
    apiVersion: 1,
    trust: "trusted",
    platforms: ["web"],
    activationEvents: ["onStartupFinished"],
  },
  activate(api) {
    api.commands.register({ id: "user.craft-hello.open", title: "Craft Hello" }, () =>
      api.window.showAnnouncement({
        id: "user.craft-hello.message",
        title: "Hello from Hands",
        body: "This plugin lives in the persistent craft directory, not in the container image.",
        primaryAction: { id: "ok", label: "OK" },
      }),
    );
    api.navigation.register({
      id: "user.craft-hello.navigation",
      title: "Craft Hello",
      surface: "sidebar-primary",
      target: { kind: "command", commandId: "user.craft-hello.open" },
    });
  },
};
