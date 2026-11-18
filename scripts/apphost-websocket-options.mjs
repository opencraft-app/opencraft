/** Compression belongs to the public AppHost transport, not individual RPCs.
 * No dictionary crosses message boundaries (including logical clients sharing
 * this socket). Small control messages avoid the compression queue entirely.
 * The optional client window offer must not be required for compression.
 */
export function appHostWebSocketOptions() {
  return {
    noServer: true,
    maxPayload: 48 * 1024 * 1024,
    perMessageDeflate: {
      threshold: 1024,
      serverNoContextTakeover: true,
      clientNoContextTakeover: true,
      serverMaxWindowBits: 12,
      concurrencyLimit: 4,
      zlibDeflateOptions: { level: 3, memLevel: 5 },
    },
  };
}
