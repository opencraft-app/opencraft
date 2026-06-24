# vela-core/src

Source modules in this folder hold pure data contracts and small helpers:

- `ack.rs`: `CommandAck` status union aligned with the OpenAPI wire contract.
- `command.rs`: backend identity and command-facing enums.
- `config.rs`: session agent config, resolved turn config, and backend discovery option DTOs.
- `event.rs`: canonical event envelope and vocabulary constants.
- `ids.rs`: ID newtypes and event cursor.
- `read_model.rs`: base structs used by projection crates.
