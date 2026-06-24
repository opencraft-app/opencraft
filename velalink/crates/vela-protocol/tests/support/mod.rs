pub fn openapi_example_fixture(name: &str) -> serde_json::Value {
    let raw = match name {
        "accepted_command_ack" => {
            include_str!("../fixtures/openapi_examples/accepted_command_ack.json")
        }
        other => panic!("unknown openapi example fixture: {other}"),
    };
    serde_json::from_str(raw).expect("openapi example fixture json")
}

pub fn diagnostic_trace_fixture(name: &str) -> Vec<serde_json::Value> {
    let raw = match name {
        "codex_trace_shape" => {
            include_str!("../fixtures/diagnostic_traces/codex_trace_shape.jsonl")
        }
        other => panic!("unknown diagnostic trace fixture: {other}"),
    };
    raw.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("diagnostic trace fixture line"))
        .collect()
}
