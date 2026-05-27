use super::*;
use base64::{engine::general_purpose::STANDARD, Engine as _};

impl E2BClient {
    pub fn from_settings(settings: &E2BToolSettings) -> Result<Self> {
        let config = E2BClientConfig::from_settings(settings)?;
        let http_client = Client::builder()
            .timeout(config.request_timeout)
            .build()
            .map_err(Error::Network)?;
        Ok(Self {
            config,
            http_client,
        })
    }

    pub async fn create_sandbox(&self, options: &CreateSandboxOptions) -> Result<E2BSandbox> {
        let request = CreateSandboxRequest {
            template_id: &options.template_id,
            timeout: options.timeout_secs,
            auto_pause: false,
            secure: true,
            allow_internet_access: true,
            metadata: &options.metadata,
        };
        let url = format!("{}/sandboxes", self.config.api_url.trim_end_matches('/'));
        let response = self
            .http_client
            .post(url)
            .header("X-API-Key", &self.config.api_key)
            .json(&request)
            .send()
            .await
            .map_err(Error::Network)?;
        let status = response.status();
        let body = response.text().await.map_err(Error::Network)?;
        if !status.is_success() {
            return Err(Error::Agent(format!(
                "E2B create sandbox failed: HTTP {}: {}",
                status, body
            )));
        }
        let parsed: CreateSandboxResponse = serde_json::from_str(&body)
            .map_err(|error| Error::ParseResponse(format!("{}: {}", error, body)))?;
        Ok(E2BSandbox {
            sandbox_id: parsed.sandbox_id,
            envd_access_token: parsed.envd_access_token.unwrap_or_default(),
            traffic_access_token: parsed.traffic_access_token.unwrap_or_default(),
            domain: parsed.domain.unwrap_or_else(|| self.config.domain.clone()),
        })
    }

    pub async fn delete_sandbox(&self, sandbox_id: &str) -> Result<()> {
        let url = format!(
            "{}/sandboxes/{}",
            self.config.api_url.trim_end_matches('/'),
            sandbox_id
        );
        let response = self
            .http_client
            .delete(url)
            .header("X-API-Key", &self.config.api_key)
            .send()
            .await
            .map_err(Error::Network)?;
        let status = response.status();
        if status.is_success() || status == reqwest::StatusCode::NOT_FOUND {
            return Ok(());
        }
        let body = response.text().await.map_err(Error::Network)?;
        Err(Error::Agent(format!(
            "E2B delete sandbox failed: HTTP {}: {}",
            status, body
        )))
    }

    pub async fn upload_file(
        &self,
        sandbox: &E2BSandbox,
        remote_path: &str,
        filename: &str,
        content: Vec<u8>,
    ) -> Result<()> {
        let form = multipart::Form::new().part(
            "file",
            multipart::Part::bytes(content).file_name(filename.to_string()),
        );
        let response = self
            .http_client
            .post(self.file_url(sandbox, remote_path))
            .header("X-Access-Token", &sandbox.envd_access_token)
            .multipart(form)
            .send()
            .await
            .map_err(Error::Network)?;
        let status = response.status();
        if status.is_success() {
            return Ok(());
        }
        let body = response.text().await.map_err(Error::Network)?;
        Err(Error::Agent(format!(
            "E2B upload failed: HTTP {}: {}",
            status, body
        )))
    }

    pub async fn download_file(&self, sandbox: &E2BSandbox, remote_path: &str) -> Result<Vec<u8>> {
        let response = self
            .http_client
            .get(self.file_url(sandbox, remote_path))
            .header("X-Access-Token", &sandbox.envd_access_token)
            .send()
            .await
            .map_err(Error::Network)?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.map_err(Error::Network)?;
            return Err(Error::Agent(format!(
                "E2B download failed: HTTP {}: {}",
                status, body
            )));
        }
        response
            .bytes()
            .await
            .map(|bytes| bytes.to_vec())
            .map_err(Error::Network)
    }

    pub async fn native_host_call(
        &self,
        sandbox: &E2BSandbox,
        port: u16,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        let response = self
            .http_client
            .post(self.sandbox_http_url(sandbox, port, "/v1/native")?)
            .header("Content-Type", "application/json")
            .header("X-Access-Token", &sandbox.envd_access_token)
            .header("e2b-traffic-access-token", sandbox.proxy_access_token())
            .header("Authorization", self.basic_user_header()?)
            .json(&serde_json::json!({
                "method": method,
                "params": params,
            }))
            .send()
            .await
            .map_err(Error::Network)?;
        let status = response.status();
        let body = response.text().await.map_err(Error::Network)?;
        if !status.is_success() {
            return Err(Error::Agent(format!(
                "sandbox-host {method} HTTP transport failed: HTTP {}: {}",
                status, body
            )));
        }
        parse_native_host_response(method, &body)
    }

    pub async fn native_host_write_file(
        &self,
        sandbox: &E2BSandbox,
        port: u16,
        remote_path: &str,
        content: Vec<u8>,
    ) -> Result<()> {
        let response = self
            .http_client
            .put(self.sandbox_fs_blob_url(sandbox, port, remote_path)?)
            .header("Content-Type", "application/octet-stream")
            .header("X-Access-Token", &sandbox.envd_access_token)
            .header("e2b-traffic-access-token", sandbox.proxy_access_token())
            .header("Authorization", self.basic_user_header()?)
            .body(content)
            .send()
            .await
            .map_err(Error::Network)?;
        let status = response.status();
        let body = response.text().await.map_err(Error::Network)?;
        if status.is_success() {
            return Ok(());
        }
        Err(Error::Agent(format!(
            "sandbox-host fs.blob write HTTP transport failed: HTTP {}: {}",
            status, body
        )))
    }

    pub async fn native_host_read_file(
        &self,
        sandbox: &E2BSandbox,
        port: u16,
        remote_path: &str,
    ) -> Result<Vec<u8>> {
        let response = self
            .http_client
            .get(self.sandbox_fs_blob_url(sandbox, port, remote_path)?)
            .header("X-Access-Token", &sandbox.envd_access_token)
            .header("e2b-traffic-access-token", sandbox.proxy_access_token())
            .header("Authorization", self.basic_user_header()?)
            .send()
            .await
            .map_err(Error::Network)?;
        let status = response.status();
        if status.is_success() {
            return response
                .bytes()
                .await
                .map(|bytes| bytes.to_vec())
                .map_err(Error::Network);
        }
        let body = response.text().await.map_err(Error::Network)?;
        Err(Error::Agent(format!(
            "sandbox-host fs.blob read HTTP transport failed: HTTP {}: {}",
            status, body
        )))
    }

    pub async fn run_command(
        &self,
        sandbox: &E2BSandbox,
        command: &str,
        envs: &HashMap<String, String>,
    ) -> Result<CommandResult> {
        let request = StartProcessRequest {
            process: ProcessStart {
                cmd: "/bin/bash",
                args: vec!["-l", "-c", command],
                envs,
            },
            stdin: false,
        };
        let body = serde_json::to_vec(&request)
            .map_err(|error| Error::ParseResponse(error.to_string()))?;
        let response = self
            .http_client
            .post(format!(
                "{}/process.Process/Start",
                self.sandbox_url(sandbox)
            ))
            .header("Content-Type", "application/connect+json")
            .header("Connect-Protocol-Version", "1")
            .header("Connect-Content-Encoding", "identity")
            .header(
                "Connect-Timeout-Ms",
                self.config.request_timeout.as_millis().to_string(),
            )
            .header("X-Access-Token", &sandbox.envd_access_token)
            .header("Authorization", self.basic_user_header()?)
            .body(connect_envelope(&body, 0))
            .send()
            .await
            .map_err(Error::Network)?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.map_err(Error::Network)?;
            return Err(Error::Agent(format!(
                "E2B run command failed: HTTP {}: {}",
                status, body
            )));
        }
        let bytes = response.bytes().await.map_err(Error::Network)?;
        read_connect_command_stream(bytes.as_ref())
    }

    fn sandbox_url(&self, sandbox: &E2BSandbox) -> String {
        self.sandbox_port_url(sandbox, self.config.envd_port)
    }

    pub(super) fn sandbox_port_url(&self, sandbox: &E2BSandbox, port: u16) -> String {
        format!("https://{}-{}.{}", port, sandbox.sandbox_id, sandbox.domain)
    }

    pub(super) fn sandbox_http_url(
        &self,
        sandbox: &E2BSandbox,
        port: u16,
        path: &str,
    ) -> Result<String> {
        let mut url = reqwest::Url::parse(&self.sandbox_port_url(sandbox, port))
            .map_err(|error| Error::ParseResponse(error.to_string()))?;
        url.set_path(path);
        if !sandbox.proxy_access_token().is_empty() {
            url.query_pairs_mut()
                .append_pair("access_token", sandbox.proxy_access_token());
        }
        Ok(url.to_string())
    }

    pub(super) fn sandbox_fs_blob_url(
        &self,
        sandbox: &E2BSandbox,
        port: u16,
        remote_path: &str,
    ) -> Result<String> {
        let mut url = reqwest::Url::parse(&self.sandbox_port_url(sandbox, port))
            .map_err(|error| Error::ParseResponse(error.to_string()))?;
        url.set_path("/v1/fs/blob");
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("path", remote_path);
            if !sandbox.proxy_access_token().is_empty() {
                query.append_pair("access_token", sandbox.proxy_access_token());
            }
        }
        Ok(url.to_string())
    }

    fn file_url(&self, sandbox: &E2BSandbox, remote_path: &str) -> String {
        let mut url = reqwest::Url::parse(&format!("{}/files", self.sandbox_url(sandbox)))
            .expect("sandbox URL should be valid");
        url.query_pairs_mut()
            .append_pair("path", remote_path)
            .append_pair("username", &self.config.envd_user);
        url.to_string()
    }

    fn basic_user_header(&self) -> Result<String> {
        let encoded = STANDARD.encode(format!("{}:", self.config.envd_user));
        Ok(format!("Basic {encoded}"))
    }
}
