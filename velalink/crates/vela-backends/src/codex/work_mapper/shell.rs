use serde_json::Value;

pub(super) fn normalize_command_value(value: &Value) -> Option<String> {
    match value {
        Value::String(command) => {
            let normalized = maybe_unwrap_shell_wrapper_command(command);
            (!normalized.is_empty()).then_some(normalized)
        }
        Value::Array(parts) => {
            let parts = parts
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>();
            if parts.is_empty() {
                return None;
            }
            if parts.len() >= 3 && matches!(parts[1], "-lc" | "-c") {
                return Some(strip_edge_quotes(parts[2].trim()));
            }
            if parts.len() >= 3
                && is_windows_shell_command(parts[0])
                && matches!(
                    parts[1].to_ascii_lowercase().as_str(),
                    "-command" | "-c" | "/c"
                )
            {
                return Some(strip_edge_quotes(&parts[2..].join(" ")));
            }
            Some(parts.join(" "))
        }
        _ => None,
    }
}

fn maybe_unwrap_shell_wrapper_command(command: &str) -> String {
    let trimmed = command.trim();
    if let Some(parts) = split_command_words(trimmed) {
        if let Some(unwrapped) = unwrap_shell_wrapper_parts(&parts) {
            return unwrapped;
        }
    }
    for prefix in [
        "/bin/zsh -lc ",
        "/bin/bash -lc ",
        "/bin/sh -c ",
        "zsh -lc ",
        "bash -lc ",
        "sh -c ",
    ] {
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            return strip_edge_quotes(rest.trim());
        }
    }
    for marker in [" -Command ", " -c ", " /c "] {
        if let Some((shell, rest)) = trimmed.split_once(marker) {
            if is_windows_shell_command(shell.trim_matches('"')) {
                return strip_edge_quotes(rest.trim());
            }
        }
    }
    trimmed.to_string()
}

fn unwrap_shell_wrapper_parts(parts: &[String]) -> Option<String> {
    let shell = parts.first()?;
    let shell_name = shell.trim_matches('"');
    if is_unix_shell_command(shell_name) {
        for (index, part) in parts.iter().enumerate().skip(1) {
            if matches!(part.as_str(), "-lc" | "-c") {
                return parts
                    .get(index + 1)
                    .map(|command| strip_edge_quotes(command));
            }
        }
    }
    if is_windows_shell_command(shell_name) {
        for (index, part) in parts.iter().enumerate().skip(1) {
            if matches!(part.to_ascii_lowercase().as_str(), "-command" | "-c" | "/c") {
                return Some(strip_edge_quotes(&parts[index + 1..].join(" ")));
            }
        }
    }
    None
}

fn split_command_words(command: &str) -> Option<Vec<String>> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;

    for ch in command.chars() {
        if let Some(active_quote) = quote {
            if ch == active_quote {
                quote = None;
            } else {
                current.push(ch);
            }
            continue;
        }

        match ch {
            '"' | '\'' => quote = Some(ch),
            ch if ch.is_whitespace() => {
                if !current.is_empty() {
                    words.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(ch),
        }
    }

    if quote.is_some() {
        return None;
    }
    if !current.is_empty() {
        words.push(current);
    }
    (!words.is_empty()).then_some(words)
}

fn strip_edge_quotes(value: &str) -> String {
    let trimmed = value.trim();
    if (trimmed.starts_with('"') && trimmed.ends_with('"'))
        || (trimmed.starts_with('\'') && trimmed.ends_with('\''))
    {
        trimmed[1..trimmed.len() - 1].to_string()
    } else {
        trimmed.to_string()
    }
}

fn is_windows_shell_command(command: &str) -> bool {
    let normalized = command.trim_matches('"').to_ascii_lowercase();
    normalized.ends_with("\\pwsh.exe")
        || normalized.ends_with("\\powershell.exe")
        || normalized.ends_with("\\cmd.exe")
        || normalized == "pwsh"
        || normalized == "powershell"
        || normalized == "cmd"
        || normalized == "cmd.exe"
}

fn is_unix_shell_command(command: &str) -> bool {
    matches!(
        command.rsplit('/').next().unwrap_or(command),
        "zsh" | "bash" | "sh"
    )
}

pub(super) fn extract_codex_shell_output(output: &str) -> String {
    let normalized = output.replace("\r\n", "\n");
    if let Some((_, body)) = normalized.split_once("\nOutput:\n") {
        return body.trim_end().to_string();
    }
    normalized.trim_end().to_string()
}
