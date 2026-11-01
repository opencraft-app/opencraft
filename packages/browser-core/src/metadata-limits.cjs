// Binding aliases cover the conversation catalog, not just open browser tabs.
const browserMetadataValueLimit = key => key === 'bindings' ? 1024 * 1024 : 64 * 1024;
// Four fields (one 1 MiB + three 64 KiB), escaped into JSON strings, plus framing.
// JSON can expand one UTF-16 code unit to six ASCII bytes.
const browserMetadataWireLimit = 8 * 1024 * 1024;
module.exports = { browserMetadataValueLimit, browserMetadataWireLimit };
