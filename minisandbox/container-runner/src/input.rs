//! The actor input payload describing how to launch the child game server.
//!
//! Everything the game server needs to launch (command, args, env, port) is
//! carried in the actor's create-time `input` payload, CBOR-encoded per the
//! RivetKit convention. All fields are optional; anything omitted falls back
//! to the CLI-provided template (`rivet-container-runner -- <command...>`).
//! The decoded input is also the actor's persisted state so a woken actor
//! restores the same launch spec without re-decoding input.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Shape of the actor `input` payload. Unknown fields are ignored rather than
/// rejected: this type is also the persisted actor state, and a strict decode
/// would break waking actors after a rollback to a binary that predates a
/// newly added field.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ActorInput {
	/// Overrides the CLI command template entirely (program + fixed args).
	#[serde(default)]
	pub command: Option<Vec<String>>,
	/// Extra args appended after the command template / `command`.
	#[serde(default)]
	pub args: Vec<String>,
	/// Extra environment variables for the child process.
	#[serde(default)]
	pub env: HashMap<String, String>,
	/// Local port the child listens on; also exported to the child as `PORT`.
	/// Falls back to the runner's `--child-port` when omitted.
	#[serde(default)]
	pub port: Option<u16>,
}

#[cfg(test)]
#[path = "../tests/inline/input.rs"]
mod tests;
