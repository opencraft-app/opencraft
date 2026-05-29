//! Web search and fetch tools
//!
//! Tools for searching the web and fetching web content.

use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::config::runtime_config;
use crate::schema::ToolSchema;
use crate::tools::{ToolContext, ToolHandler, ToolResult};

/// Tool for searching the web
pub struct WebSearchTool;

#[derive(JsonSchema, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebSearchArgs {
    query: String,
    num_results: Option<usize>,
    site: Option<String>,
    #[serde(alias = "from_time")]
    from_time: Option<i64>,
    #[serde(alias = "to_time")]
    to_time: Option<i64>,
    mode: Option<u8>,
    industry: Option<String>,
}

#[async_trait]
impl ToolHandler for WebSearchTool {
    fn name(&self) -> &str {
        "web_search"
    }

    fn description(&self) -> &str {
        "Search the web for information. Returns relevant results with titles and snippets."
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema::from_type::<WebSearchArgs>("web_search", "Search the web")
    }

    async fn execute(&self, args: Value, _context: ToolContext) -> ToolResult {
        let args: WebSearchArgs = match serde_json::from_value(args) {
            Ok(a) => a,
            Err(e) => return ToolResult::error("web_search", format!("Invalid arguments: {}", e)),
        };

        let settings = runtime_config().tools.web;
        match settings
            .search_provider
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "duckduckgo_lite" | "duckduckgo" | "ddg_lite" | "ddg" => {
                search_duckduckgo_lite(args, &settings).await
            }
            "tencent_wsa" | "tencent" | "wsa" => search_tencent_wsa(args, &settings).await,
            other => ToolResult::error(
                "web_search",
                format!("Unsupported search provider: {}", other),
            ),
        }
    }
}

async fn search_duckduckgo_lite(
    args: WebSearchArgs,
    settings: &crate::config::WebToolSettings,
) -> ToolResult {
    let num_results = args
        .num_results
        .unwrap_or(settings.default_results)
        .min(settings.max_results);
    let query_encoded = urlencoding::encode(&args.query);
    let search_url = settings.search_url.replace("{query}", &query_encoded);

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(settings.search_timeout_secs))
        .user_agent(settings.user_agent.clone())
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return ToolResult::error("web_search", format!("Failed to create HTTP client: {}", e))
        }
    };

    match client.get(&search_url).send().await {
        Ok(response) => {
            if !response.status().is_success() {
                return ToolResult::success(
                    "web_search",
                    json!({
                        "provider": "duckduckgo_lite",
                        "query": args.query,
                        "search_url": search_url,
                        "results": [],
                        "error": format!("Search returned status {}", response.status())
                    }),
                );
            }

            match response.text().await {
                Ok(html) => {
                    let results = parse_ddg_lite_results(&html, num_results);
                    ToolResult::success(
                        "web_search",
                        json!({
                            "provider": "duckduckgo_lite",
                            "query": args.query,
                            "num_results": results.len(),
                            "results": results
                        }),
                    )
                }
                Err(e) => ToolResult::error(
                    "web_search",
                    format!("Failed to read search response: {}", e),
                ),
            }
        }
        Err(e) => ToolResult::error("web_search", format!("Search request failed: {}", e)),
    }
}

async fn search_tencent_wsa(
    args: WebSearchArgs,
    settings: &crate::config::WebToolSettings,
) -> ToolResult {
    let api_key = settings
        .tencent_wsa_api_key
        .clone()
        .or_else(|| std::env::var(&settings.tencent_wsa_api_key_env).ok())
        .filter(|value| !value.trim().is_empty());
    let Some(api_key) = api_key else {
        return ToolResult::error(
            "web_search",
            format!(
                "Tencent WSA API key is missing; set {}",
                settings.tencent_wsa_api_key_env
            ),
        );
    };

    let num_results = args
        .num_results
        .unwrap_or(settings.default_results)
        .min(settings.max_results);
    let mut body = serde_json::Map::new();
    body.insert("Query".to_string(), json!(args.query));
    if let Some(mode) = args.mode.or(settings.tencent_wsa_mode) {
        body.insert("Mode".to_string(), json!(mode));
    }
    if let Some(site) = args.site.filter(|value| !value.trim().is_empty()) {
        body.insert("Site".to_string(), json!(site));
    }
    if let Some(from_time) = args.from_time {
        body.insert("FromTime".to_string(), json!(from_time));
    }
    if let Some(to_time) = args.to_time {
        body.insert("ToTime".to_string(), json!(to_time));
    }
    if let Some(industry) = args.industry.filter(|value| !value.trim().is_empty()) {
        body.insert("Industry".to_string(), json!(industry));
    }
    if let Some(requested_results) = args.num_results {
        body.insert("Cnt".to_string(), json!(tencent_wsa_cnt(requested_results)));
    }

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(settings.search_timeout_secs))
        .user_agent(settings.user_agent.clone())
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return ToolResult::error("web_search", format!("Failed to create HTTP client: {}", e))
        }
    };

    let response = match client
        .post(&settings.tencent_wsa_endpoint)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json; charset=utf-8")
        .json(&body)
        .send()
        .await
    {
        Ok(response) => response,
        Err(e) => return ToolResult::error("web_search", format!("Search request failed: {}", e)),
    };

    let status = response.status();
    let text = match response.text().await {
        Ok(text) => text,
        Err(e) => {
            return ToolResult::error(
                "web_search",
                format!("Failed to read search response: {}", e),
            )
        }
    };
    let value: serde_json::Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(e) => {
            return ToolResult::error(
                "web_search",
                format!("Failed to parse Tencent WSA response: {}", e),
            )
        }
    };
    let response = value.get("Response").unwrap_or(&value);
    if !status.is_success() {
        return ToolResult::success(
            "web_search",
            json!({
                "provider": "tencent_wsa",
                "query": body.get("Query").cloned().unwrap_or_default(),
                "results": [],
                "status_code": status.as_u16(),
                "error": response.get("Error").cloned().unwrap_or_else(|| json!(text)),
            }),
        );
    }
    if let Some(error) = response.get("Error") {
        return ToolResult::success(
            "web_search",
            json!({
                "provider": "tencent_wsa",
                "query": response.get("Query").cloned().unwrap_or_else(|| body.get("Query").cloned().unwrap_or_default()),
                "results": [],
                "error": error,
                "request_id": response.get("RequestId").cloned().unwrap_or_default(),
            }),
        );
    }

    let results = parse_tencent_wsa_pages(response)
        .into_iter()
        .take(num_results)
        .collect::<Vec<_>>();
    ToolResult::success(
        "web_search",
        json!({
            "provider": "tencent_wsa",
            "query": response.get("Query").cloned().unwrap_or_else(|| body.get("Query").cloned().unwrap_or_default()),
            "num_results": results.len(),
            "results": results,
            "version": response.get("Version").cloned().unwrap_or_default(),
            "msg": response.get("Msg").cloned().unwrap_or_default(),
            "request_id": response.get("RequestId").cloned().unwrap_or_default(),
        }),
    )
}

fn tencent_wsa_cnt(num_results: usize) -> usize {
    match num_results {
        0..=10 => 10,
        11..=20 => 20,
        21..=30 => 30,
        31..=40 => 40,
        _ => 50,
    }
}

fn parse_tencent_wsa_pages(response: &serde_json::Value) -> Vec<serde_json::Value> {
    response
        .get("Pages")
        .and_then(serde_json::Value::as_array)
        .map(|pages| {
            pages
                .iter()
                .filter_map(|page| {
                    let page_value = match page {
                        serde_json::Value::String(raw) => serde_json::from_str(raw).ok()?,
                        value if value.is_object() => value.clone(),
                        _ => return None,
                    };
                    let title = page_value
                        .get("title")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default();
                    let url = page_value
                        .get("url")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default();
                    let snippet = page_value
                        .get("passage")
                        .or_else(|| page_value.get("content"))
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default();
                    Some(json!({
                        "title": title,
                        "url": url,
                        "snippet": snippet,
                        "site": page_value.get("site").cloned().unwrap_or_default(),
                        "date": page_value.get("date").cloned().unwrap_or_default(),
                        "score": page_value.get("score").cloned().unwrap_or_default(),
                        "images": page_value.get("images").cloned().unwrap_or_default(),
                        "favicon": page_value.get("favicon").cloned().unwrap_or_default(),
                        "raw": page_value,
                    }))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Tool for fetching web pages
pub struct WebFetchTool;

#[derive(JsonSchema, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebFetchArgs {
    url: String,
    method: Option<String>,
    headers: Option<std::collections::HashMap<String, String>>,
    body: Option<String>,
    timeout: Option<u64>,
}

#[async_trait]
impl ToolHandler for WebFetchTool {
    fn name(&self) -> &str {
        "web_fetch"
    }

    fn description(&self) -> &str {
        "Fetch content from a URL. Supports GET and POST requests with custom headers and body."
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema::from_type::<WebFetchArgs>("web_fetch", "Fetch URL content")
    }

    async fn execute(&self, args: Value, _context: ToolContext) -> ToolResult {
        let args: WebFetchArgs = match serde_json::from_value(args) {
            Ok(a) => a,
            Err(e) => return ToolResult::error("web_fetch", format!("Invalid arguments: {}", e)),
        };
        let settings = runtime_config().tools.web;

        // Validate URL
        match reqwest::Url::parse(&args.url) {
            Ok(url) => {
                if url.scheme() != "http" && url.scheme() != "https" {
                    return ToolResult::error(
                        "web_fetch",
                        "Only HTTP and HTTPS URLs are supported",
                    );
                }
            }
            Err(e) => return ToolResult::error("web_fetch", format!("Invalid URL: {}", e)),
        }

        let client = match reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(
                args.timeout.unwrap_or(settings.fetch_timeout_secs),
            ))
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                return ToolResult::error(
                    "web_fetch",
                    format!("Failed to create HTTP client: {}", e),
                )
            }
        };

        let method = args.method.as_deref().unwrap_or("GET");
        let mut request = match method {
            "GET" => client.get(&args.url),
            "POST" => client.post(&args.url),
            "PUT" => client.put(&args.url),
            "DELETE" => client.delete(&args.url),
            "PATCH" => client.patch(&args.url),
            "HEAD" => client.head(&args.url),
            _ => {
                return ToolResult::error(
                    "web_fetch",
                    format!("Unsupported HTTP method: {}", method),
                )
            }
        };

        // Add custom headers
        if let Some(ref headers) = args.headers {
            for (key, value) in headers {
                request = request.header(key, value);
            }
        }

        // Add body for POST/PUT/PATCH
        if let Some(ref body) = args.body {
            if !body.is_empty() {
                request = request.body(body.clone());
            }
        }

        match request.send().await {
            Ok(response) => {
                let status = response.status();
                let headers: std::collections::HashMap<String, String> = response
                    .headers()
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
                    .collect();

                match response.text().await {
                    Ok(body) => {
                        let body_size = body.len();
                        ToolResult::success(
                            "web_fetch",
                            serde_json::json!({
                                "url": args.url,
                                "method": method,
                                "status_code": status.as_u16(),
                                "status_text": status.canonical_reason().unwrap_or(""),
                                "headers": headers,
                                "body": body,
                                "body_size": body_size
                            }),
                        )
                    }
                    Err(e) => ToolResult::error(
                        "web_fetch",
                        format!("Failed to read response body: {}", e),
                    ),
                }
            }
            Err(e) => ToolResult::error("web_fetch", format!("Request failed: {}", e)),
        }
    }
}

// URL encoding helper
mod urlencoding {
    pub fn encode(input: &str) -> String {
        let mut encoded = String::new();
        for byte in input.bytes() {
            match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    encoded.push(byte as char);
                }
                _ => {
                    encoded.push_str(&format!("%{:02X}", byte));
                }
            }
        }
        encoded
    }
}

/// Parse DuckDuckGo Lite HTML results into structured JSON values.
///
/// DDG Lite uses a simple table layout where each result has:
/// - A link in an `<a>` tag with class "result-link"  
/// - A snippet in a `<td>` with class "result-snippet"
fn parse_ddg_lite_results(html: &str, max_results: usize) -> Vec<serde_json::Value> {
    let mut results = Vec::new();

    // DDG Lite format: results are in <a class="result-link" href="URL">TITLE</a>
    // followed by <td class="result-snippet">SNIPPET</td>
    let mut pos = 0;
    let html_bytes = html.as_bytes();

    while results.len() < max_results && pos < html.len() {
        // Find next result link
        let link_marker = "class=\"result-link\"";
        let link_pos = match html[pos..].find(link_marker) {
            Some(p) => pos + p,
            None => break,
        };

        // Extract href from the <a> tag
        let href_start = match html[..link_pos].rfind("href=\"") {
            Some(p) => p + 6,
            None => {
                pos = link_pos + link_marker.len();
                continue;
            }
        };
        let href_end = match html[href_start..].find('"') {
            Some(p) => href_start + p,
            None => {
                pos = link_pos + link_marker.len();
                continue;
            }
        };
        let url = html_decode(&html[href_start..href_end]);

        // Extract title (content between > and </a>)
        let title_start = match html[link_pos..].find('>') {
            Some(p) => link_pos + p + 1,
            None => {
                pos = link_pos + link_marker.len();
                continue;
            }
        };
        let title_end = match html[title_start..].find("</a>") {
            Some(p) => title_start + p,
            None => {
                pos = link_pos + link_marker.len();
                continue;
            }
        };
        let title = strip_html_tags(&html[title_start..title_end]);

        // Find snippet after the link
        let snippet_marker = "class=\"result-snippet\"";
        let snippet = if let Some(sp) = html[title_end..].find(snippet_marker) {
            let snippet_pos = title_end + sp;
            let content_start = match html[snippet_pos..].find('>') {
                Some(p) => snippet_pos + p + 1,
                None => snippet_pos,
            };
            let content_end = match html[content_start..].find("</td>") {
                Some(p) => content_start + p,
                None => content_start,
            };
            strip_html_tags(&html[content_start..content_end])
        } else {
            String::new()
        };

        // Skip DDG internal links
        if !url.starts_with("https://duckduckgo.com") && !url.is_empty() && !title.is_empty() {
            results.push(serde_json::json!({
                "title": title.trim(),
                "url": url,
                "snippet": snippet.trim()
            }));
        }

        pos = title_end;
    }

    // If we couldn't parse the Lite format, try a simpler heuristic approach
    if results.is_empty() {
        // Look for any <a href="http..."> patterns
        pos = 0;
        while results.len() < max_results && pos < html.len() {
            let href_marker = "href=\"http";
            let hp = match html[pos..].find(href_marker) {
                Some(p) => pos + p + 6,
                None => break,
            };
            let href_end = match html[hp..].find('"') {
                Some(p) => hp + p,
                None => break,
            };
            let url = html_decode(&html[hp..href_end]);

            // Get link text
            let text_start = match html[href_end..].find('>') {
                Some(p) => href_end + p + 1,
                None => {
                    pos = href_end;
                    continue;
                }
            };
            let text_end = match html[text_start..].find('<') {
                Some(p) => text_start + p,
                None => {
                    pos = href_end;
                    continue;
                }
            };
            let title = html[text_start..text_end].trim().to_string();

            if !url.contains("duckduckgo.com") && title.len() > 3 {
                results.push(serde_json::json!({
                    "title": title,
                    "url": url,
                    "snippet": ""
                }));
            }
            pos = text_end;
        }
    }

    let _ = html_bytes; // used for borrow check
    results
}

/// Strip HTML tags from a string.
fn strip_html_tags(s: &str) -> String {
    let mut result = String::new();
    let mut in_tag = false;
    for ch in s.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => result.push(ch),
            _ => {}
        }
    }
    html_decode(&result)
}

/// Decode common HTML entities.
fn html_decode(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&#x27;", "'")
        .replace("&nbsp;", " ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tencent_wsa_pages_from_json_strings() {
        let response = json!({
            "Pages": [
                "{\"passage\":\"summary\",\"score\":0.9,\"date\":\"2026-05-23\",\"title\":\"Title\",\"url\":\"https://example.com\",\"site\":\"Example\",\"images\":[],\"favicon\":\"https://example.com/favicon.ico\"}"
            ],
            "Query": "query",
            "RequestId": "request-1"
        });

        let results = parse_tencent_wsa_pages(&response);

        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["title"], "Title");
        assert_eq!(results[0]["url"], "https://example.com");
        assert_eq!(results[0]["snippet"], "summary");
        assert_eq!(results[0]["site"], "Example");
    }

    #[test]
    fn rounds_tencent_wsa_cnt_to_supported_values() {
        assert_eq!(tencent_wsa_cnt(1), 10);
        assert_eq!(tencent_wsa_cnt(20), 20);
        assert_eq!(tencent_wsa_cnt(21), 30);
        assert_eq!(tencent_wsa_cnt(50), 50);
        assert_eq!(tencent_wsa_cnt(99), 50);
    }
}
