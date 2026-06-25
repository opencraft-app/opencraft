#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VelaEngineConfig {
    pub endpoint: String,
    pub api_key: String,
    pub model: String,
    pub cwd: String,
}

impl VelaEngineConfig {
    pub fn new(
        endpoint: impl Into<String>,
        api_key: impl Into<String>,
        model: impl Into<String>,
        cwd: impl Into<String>,
    ) -> Self {
        Self {
            endpoint: endpoint.into(),
            api_key: api_key.into(),
            model: model.into(),
            cwd: cwd.into(),
        }
    }

    pub fn validate(&self) -> anyhow::Result<()> {
        ensure_non_empty("endpoint", &self.endpoint)?;
        ensure_non_empty("api_key", &self.api_key)?;
        ensure_non_empty("model", &self.model)?;
        ensure_non_empty("cwd", &self.cwd)?;
        Ok(())
    }

    pub fn is_configured(&self) -> bool {
        !self.endpoint.trim().is_empty()
            && !self.api_key.trim().is_empty()
            && !self.model.trim().is_empty()
            && !self.cwd.trim().is_empty()
    }
}

fn ensure_non_empty(field: &str, value: &str) -> anyhow::Result<()> {
    if value.trim().is_empty() {
        anyhow::bail!("vela_engine {field} is required");
    }
    Ok(())
}
