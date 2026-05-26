use std::time::Instant;

use tracing_subscriber::EnvFilter;

pub(crate) fn init_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .without_time()
        .compact()
        .try_init();
}

pub(crate) fn timeline<const N: usize>(event: &str, fields: [(&str, String); N]) {
    let elapsed = elapsed_secs();
    let mut parts = vec![format!(
        "timeline source=hermes_sidecar t={elapsed:.3}s event={event}"
    )];
    for (key, value) in fields {
        let encoded = serde_json::to_string(value.as_str()).unwrap_or_else(|_| "\"\"".to_string());
        parts.push(format!("{}={}", key, encoded));
    }
    eprintln!("{}", parts.join(" "));
}

pub(crate) fn elapsed_secs() -> f64 {
    static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64()
}
