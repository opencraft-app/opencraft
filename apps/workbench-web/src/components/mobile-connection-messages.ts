import { defineMessages } from "@opencraft/i18n";

export const mobileConnectionMessages = defineMessages({
  title: { id: "mobile.connection.title", defaultMessage: "Connect a server" },
  description: { id: "mobile.connection.description", defaultMessage: "Connect to your OpenCraft server to start working. Your server manages sign-in and access." },
  badge: { id: "mobile.connection.badge", defaultMessage: "HTTPS · Server Endpoint" },
  group: { id: "mobile.connection.group", defaultMessage: "Server endpoint" },
  address: { id: "mobile.connection.address", defaultMessage: "Server address" },
  addressPlaceholder: { id: "mobile.connection.addressPlaceholder", defaultMessage: "https://workbench.example.com" },
  addressHint: { id: "mobile.connection.addressHint", defaultMessage: "Enter an HTTPS server address without a path or sign-in details." },
  nameLabel: { id: "mobile.connection.nameLabel", defaultMessage: "Display name (optional)" },
  namePlaceholder: { id: "mobile.connection.namePlaceholder", defaultMessage: "Team or home server" },
  clear: { id: "mobile.connection.clear", defaultMessage: "Clear" },
  privacyTitle: { id: "mobile.connection.privacyTitle", defaultMessage: "End-to-end TLS & server-owned credentials" },
  privacyMessage: { id: "mobile.connection.privacyMessage", defaultMessage: "Model keys and workspace files remain on your server; only encrypted RPC frames cross this link." },
  connecting: { id: "mobile.connection.connecting", defaultMessage: "Connecting…" },
  connected: { id: "mobile.connection.connected", defaultMessage: "Server connected and added to your machines." },
  failed: { id: "mobile.connection.failed", defaultMessage: "The connection could not be saved. Check the address and try again." },
});
