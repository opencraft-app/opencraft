use serde_json::{json, Value};

pub(super) fn format_search_result(
    results: Vec<Value>,
    target: &str,
    output_mode: &str,
    offset: usize,
    limit: usize,
    max_results: usize,
) -> Value {
    let truncated = results.len() >= max_results;
    if matches!(target, "content" | "grep") && output_mode == "files_only" {
        let mut seen = std::collections::HashSet::new();
        let mut files = Vec::new();
        for entry in &results {
            let file = entry
                .get("file")
                .or_else(|| entry.get("path"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if !file.is_empty() && seen.insert(file.to_string()) {
                files.push(Value::String(file.to_string()));
            }
        }
        let total_count = files.len();
        let page = page_values(&files, offset, limit);
        return json!({
            "files": page,
            "count": page_values(&files, offset, limit).len(),
            "total_count": total_count,
            "truncated": truncated || total_count > offset.saturating_add(limit),
            "next_offset": if truncated || total_count > offset.saturating_add(limit) { Some(offset.saturating_add(limit)) } else { None },
        });
    }
    if matches!(target, "content" | "grep") && output_mode == "count" {
        let mut counts = serde_json::Map::new();
        for entry in &results {
            let file = entry
                .get("file")
                .or_else(|| entry.get("path"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if !file.is_empty() {
                let next = counts.get(file).and_then(Value::as_u64).unwrap_or(0) + 1;
                counts.insert(file.to_string(), Value::from(next));
            }
        }
        return json!({
            "counts": counts,
            "count": results.len(),
            "total_count": results.len(),
            "truncated": truncated,
            "next_offset": if truncated { Some(offset.saturating_add(limit)) } else { None },
        });
    }

    let page = page_values(&results, offset, limit);
    let page_len = page.len();
    json!({
        "matches": page,
        "count": page_len,
        "total_count": results.len(),
        "truncated": truncated || results.len() > offset.saturating_add(limit),
        "next_offset": if truncated || results.len() > offset.saturating_add(limit) { Some(offset.saturating_add(limit)) } else { None },
    })
}

fn page_values(values: &[Value], offset: usize, limit: usize) -> Vec<Value> {
    values.iter().skip(offset).take(limit).cloned().collect()
}

pub(super) fn truncate_search_line(value: &str, max_bytes: usize) -> (String, bool) {
    if value.len() <= max_bytes {
        return (value.to_string(), false);
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    (format!("{}...[line truncated]", &value[..end]), true)
}

pub(super) fn contains_match(haystack: &str, needle: &str, case_sensitive: bool) -> bool {
    if case_sensitive {
        haystack.contains(needle)
    } else {
        haystack.to_lowercase().contains(&needle.to_lowercase())
    }
}

pub(super) fn wildcard_match(pattern: &str, value: &str) -> bool {
    let pattern = pattern.as_bytes();
    let value = value.as_bytes();
    let (mut pi, mut vi) = (0, 0);
    let mut star = None;
    let mut star_vi = 0;
    while vi < value.len() {
        if pi < pattern.len() && (pattern[pi] == b'?' || pattern[pi] == value[vi]) {
            pi += 1;
            vi += 1;
        } else if pi < pattern.len() && pattern[pi] == b'*' {
            star = Some(pi);
            pi += 1;
            star_vi = vi;
        } else if let Some(star_pi) = star {
            pi = star_pi + 1;
            star_vi += 1;
            vi = star_vi;
        } else {
            return false;
        }
    }
    while pi < pattern.len() && pattern[pi] == b'*' {
        pi += 1;
    }
    pi == pattern.len()
}
