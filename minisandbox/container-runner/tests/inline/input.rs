use super::*;

fn decode(json: &str) -> anyhow::Result<ActorInput> {
	// Field handling (defaults, deny_unknown_fields) is format-agnostic in
	// serde, so JSON exercises the same paths as the CBOR wire encoding.
	Ok(serde_json::from_str(json)?)
}

#[test]
fn empty_object_yields_defaults() {
	let input = decode("{}").unwrap();
	assert!(input.command.is_none());
	assert!(input.args.is_empty());
	assert!(input.env.is_empty());
	assert!(input.port.is_none());
}

#[test]
fn full_input_decodes() {
	let input = decode(
		r#"{"command":["./GameServer","-batchmode"],"args":["-x"],"env":{"A":"1"},"port":7777}"#,
	)
	.unwrap();
	assert_eq!(
		input.command.as_deref(),
		Some(&["./GameServer".to_string(), "-batchmode".to_string()][..])
	);
	assert_eq!(input.args, vec!["-x".to_string()]);
	assert_eq!(input.env.get("A").map(String::as_str), Some("1"));
	assert_eq!(input.port, Some(7777));
}

#[test]
fn unknown_fields_are_ignored() {
	// Lenient by design: ActorInput doubles as persisted state, so a rollback
	// must still decode state written by a newer binary with extra fields.
	let input = decode(r#"{"port":7777,"future_field":123}"#).unwrap();
	assert_eq!(input.port, Some(7777));
}

#[test]
fn default_matches_empty() {
	let default = ActorInput::default();
	assert!(default.command.is_none());
	assert!(default.args.is_empty());
	assert!(default.env.is_empty());
	assert!(default.port.is_none());
}
