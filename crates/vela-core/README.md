# vela-core

`vela-core` defines stable domain types shared by the engine: IDs, command acknowledgements, backend kinds, canonical events, event cursors, and read model base structs.

This crate must stay free of SQLite, HTTP, backend process management, and UI projection side effects.
