pub fn command_ack_fixture(name: &str) -> serde_json::Value {
    let raw = match name {
        "accepted" => include_str!("../fixtures/command_ack/accepted.json"),
        "rejected_minimal" => include_str!("../fixtures/command_ack/rejected_minimal.json"),
        other => panic!("unknown command ack fixture: {other}"),
    };
    serde_json::from_str(raw).expect("command ack fixture json")
}
