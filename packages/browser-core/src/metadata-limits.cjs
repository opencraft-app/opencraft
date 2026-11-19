// Binding aliases cover the conversation catalog, not just open browser tabs.
const browserMetadataValueLimit = key => (key === 'bindings' || key === 'sideChats') ? 1024 * 1024 : 64 * 1024;
// A snapshot has four fields; a record-merge write has both base and next value
// (up to two 1 MiB binding fields), escaped into JSON strings, plus framing.
// JSON can expand one UTF-16 code unit to six ASCII bytes.
const browserMetadataWireLimit = 16 * 1024 * 1024;
module.exports = { browserMetadataValueLimit, browserMetadataWireLimit };
