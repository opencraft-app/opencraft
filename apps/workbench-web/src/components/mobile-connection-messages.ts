import { defineMessages } from "@opencraft/i18n";

export const mobileConnectionMessages = defineMessages({
  title: { id: "mobile.connection.title", defaultMessage: "Connect a server" },
  description: { id: "mobile.connection.description", defaultMessage: "Connect to your OpenCraft server to start working. Your server manages sign-in and access." },
  address: { id: "mobile.connection.address", defaultMessage: "Secure WebSocket address" },
  addressHint: { id: "mobile.connection.addressHint", defaultMessage: "Use the full secure WebSocket address provided by your server administrator." },
  failed: { id: "mobile.connection.failed", defaultMessage: "The connection could not be saved. Check the address and try again." },
});
