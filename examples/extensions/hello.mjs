/** @type {import('@opencraft/extension-contract').OpenCraftExtensionDefinition} */
const extension = {
  manifest: {
    manifestVersion: 1,
    id: "example.hello",
    name: "Hello extension",
    version: "1.0.0",
    apiVersion: 1,
    trust: "trusted",
    platforms: ["web", "electron"],
    activationEvents: ["onStartupFinished"],
  },
  activate(api) {
    api.commands.register({ id: "example.hello.open", title: "Hello extension" }, () =>
      api.window.showAnnouncement({
        id: "example.hello.message",
        title: "Hello from a public extension",
        body: "The application owns this window and retires it when this extension is disabled.",
        primaryAction: { id: "ok", label: "OK" },
      }));
    api.navigation.register({
      id: "example.hello.entry",
      title: "Hello extension",
      surface: "sidebar-primary",
      target: { kind: "command", commandId: "example.hello.open" },
    });
  },
};

export default extension;
