use serde_json::Value;
use vela_backends::{BackendAdapter, BackendOutput, BackendSend, backend_output_channel};
use vela_backends::{PiJsonlCodec, PiRuntimeMessage};
use vela_core::EventType;

#[allow(dead_code)]
pub async fn collect_backend_outputs<B>(
    backend: &B,
    input: BackendSend,
) -> anyhow::Result<Vec<BackendOutput>>
where
    B: BackendAdapter,
{
    let (sink, mut receiver) = backend_output_channel(32);
    let stream = backend.stream_user_message(input, sink);
    tokio::pin!(stream);
    let mut outputs = Vec::new();

    loop {
        tokio::select! {
            result = &mut stream => {
                result?;
                while let Some(output) = receiver.recv().await {
                    outputs.push(output?);
                }
                break;
            }
            output = receiver.recv() => {
                match output {
                    Some(output) => outputs.push(output?),
                    None => {
                        stream.await?;
                        break;
                    }
                }
            }
        }
    }

    Ok(outputs)
}

#[allow(dead_code)]
pub fn read_fixture(path: &str) -> &'static str {
    match path {
        "pi/assistant_text_turn.jsonl" => {
            include_str!("../fixtures/pi/assistant_text_turn.jsonl")
        }
        "pi/tool_lifecycle_bash.jsonl" => {
            include_str!("../fixtures/pi/tool_lifecycle_bash.jsonl")
        }
        "pi/unknown_event.jsonl" => include_str!("../fixtures/pi/unknown_event.jsonl"),
        other => panic!("unknown backend fixture: {other}"),
    }
}

#[allow(dead_code)]
pub fn normalize_pi_fixture(path: &str) -> Vec<BackendOutput> {
    let mut codec = PiJsonlCodec::default();
    codec
        .push_chunk(read_fixture(path))
        .expect("fixture parses as pi jsonl")
        .into_iter()
        .flat_map(|message| match message {
            PiRuntimeMessage::Response(_) => Vec::new(),
            PiRuntimeMessage::Event(event) => vela_backends::normalize_pi_event(event),
        })
        .collect()
}

#[allow(dead_code)]
pub fn assert_event_types(outputs: &[BackendOutput], expected: &[EventType]) {
    let actual = outputs
        .iter()
        .map(|output| output.event_type)
        .collect::<Vec<_>>();
    assert_eq!(
        actual, expected,
        "normalized backend event types did not match fixture contract"
    );
}

#[allow(dead_code)]
pub fn validate_backend_output_contract(
    provider: &str,
    outputs: &[BackendOutput],
) -> Result<(), String> {
    validate_streaming_assistant_delta_identity(provider, outputs)
}

#[allow(dead_code)]
pub fn assert_backend_output_contract(provider: &str, outputs: &[BackendOutput]) {
    if let Err(error) = validate_backend_output_contract(provider, outputs) {
        panic!("{error}");
    }
}

fn validate_streaming_assistant_delta_identity(
    provider: &str,
    outputs: &[BackendOutput],
) -> Result<(), String> {
    let mut run: Vec<&BackendOutput> = Vec::new();
    for output in outputs {
        if output.event_type == EventType::ASSISTANT_MESSAGE_DELTA {
            run.push(output);
            continue;
        }

        validate_assistant_delta_run(provider, &run)?;
        run.clear();
    }
    validate_assistant_delta_run(provider, &run)
}

fn validate_assistant_delta_run(provider: &str, run: &[&BackendOutput]) -> Result<(), String> {
    if run.len() <= 1 {
        return Ok(());
    }

    let Some(first_message_id) = assistant_message_id(run[0]) else {
        return Err(format!(
            "{provider} emitted {} consecutive assistant.message.delta events without a stable message_id",
            run.len()
        ));
    };

    for output in run.iter().skip(1) {
        let Some(message_id) = assistant_message_id(output) else {
            return Err(format!(
                "{provider} emitted a streaming assistant.message.delta without message_id"
            ));
        };
        if message_id != first_message_id {
            return Err(format!(
                "{provider} emitted consecutive assistant.message.delta events with different message_id values: {first_message_id:?} then {message_id:?}"
            ));
        }
    }

    Ok(())
}

fn assistant_message_id(output: &BackendOutput) -> Option<String> {
    output
        .payload
        .get("message_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[allow(dead_code)]
pub fn raw_types(outputs: &[BackendOutput]) -> Vec<Option<String>> {
    outputs
        .iter()
        .map(|output| {
            output
                .raw
                .as_ref()
                .and_then(Value::as_object)
                .and_then(|object| object.get("type"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect()
}
