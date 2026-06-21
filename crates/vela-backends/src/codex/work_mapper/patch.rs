use super::util::normalize_file_path;

#[derive(Clone, Debug)]
enum CodexPatchDirective {
    Add(String),
    Update(String),
    Delete(String),
}

pub(super) fn codex_apply_patch_to_unified_diff(
    patch: &str,
    cwd: Option<&str>,
) -> Option<(String, String)> {
    if !patch.contains("*** Begin Patch") {
        return None;
    }

    let mut files = Vec::new();
    let mut current: Option<(CodexPatchDirective, Vec<String>)> = None;

    for line in patch.replace("\r\n", "\n").lines() {
        if line == "*** Begin Patch" || line == "*** End Patch" {
            continue;
        }

        if let Some(directive) = parse_codex_patch_directive(line, cwd) {
            if let Some(file) = current.take() {
                files.push(file);
            }
            current = Some((directive, Vec::new()));
            continue;
        }

        if let Some((_, lines)) = current.as_mut() {
            if line.starts_with("***") {
                continue;
            }
            lines.push(line.to_string());
        }
    }

    if let Some(file) = current.take() {
        files.push(file);
    }

    let first_path = files
        .first()
        .map(|(directive, _)| directive.path().to_string())?;
    let diffs = files
        .into_iter()
        .map(|(directive, lines)| directive.to_unified_diff(&lines))
        .collect::<Vec<_>>()
        .join("\n\n");
    Some((first_path, diffs))
}

fn parse_codex_patch_directive(line: &str, cwd: Option<&str>) -> Option<CodexPatchDirective> {
    let (prefix, path) = line.split_once(": ")?;
    let path = normalize_file_path(path, cwd);
    match prefix {
        "*** Add File" => Some(CodexPatchDirective::Add(path)),
        "*** Update File" => Some(CodexPatchDirective::Update(path)),
        "*** Delete File" => Some(CodexPatchDirective::Delete(path)),
        _ => None,
    }
}

impl CodexPatchDirective {
    fn path(&self) -> &str {
        match self {
            Self::Add(path) | Self::Update(path) | Self::Delete(path) => path,
        }
    }

    fn to_unified_diff(&self, lines: &[String]) -> String {
        let path = self.path();
        let header = match self {
            Self::Add(_) => format!("diff --git a/{path} b/{path}\n--- /dev/null\n+++ b/{path}"),
            Self::Update(_) => {
                format!("diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}")
            }
            Self::Delete(_) => format!("diff --git a/{path} b/{path}\n--- a/{path}\n+++ /dev/null"),
        };
        if lines.is_empty() {
            return header;
        }
        format!("{header}\n{}", lines.join("\n"))
    }
}
