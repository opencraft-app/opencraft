//! Skills system for the agent runtime.
//!
//! Provides skill discovery, loading, and management matching
//! the Python hermes-agent's skills architecture. Skills are
//! directories containing a SKILL.md file with YAML front matter.

use crate::error::{Error, Result};
use crate::hooks::PromptTransformHook;
use crate::turn::TurnContext;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tracing::debug;

const WORKSPACE_SKILL_DIRS: &[&str] = &[
    ".agents/skills",
    ".codex/skills",
    ".hermes/skills",
    "skills",
];

/// A loaded skill with parsed metadata and content.
#[derive(Debug, Clone)]
pub struct Skill {
    /// Unique skill name (derived from directory name)
    pub name: String,
    /// Human-readable description
    pub description: String,
    /// Semantic version string
    pub version: String,
    /// The full SKILL.md content (body after front matter)
    pub content: String,
    /// Supported platforms (e.g. ["linux", "macos", "windows"])
    pub platforms: Vec<String>,
    /// Required environment variables
    pub prerequisites_env: Vec<String>,
    /// Required commands on PATH
    pub prerequisites_commands: Vec<String>,
    /// Optional activation hints used by turn-time resolution.
    pub activation_keywords: Vec<String>,
    /// Whether this skill should be loaded for every turn in its discovered cwd scope.
    pub autoload: bool,
    /// Whether this skill explicitly contributes tools. Skills do not provide
    /// tools by default.
    pub provides_tools: bool,
    /// Injection point for the main SKILL.md body.
    pub injection_point: SkillInjectionPoint,
    /// Directory containing this skill.
    pub skill_dir: PathBuf,
    /// Supporting reference files: filename -> content
    pub references: HashMap<String, String>,
}

/// Where a skill's primary content is injected for a turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillInjectionPoint {
    Prompt,
    Message,
    Inference,
}

impl Default for SkillInjectionPoint {
    fn default() -> Self {
        Self::Message
    }
}

/// Turn-scoped skill selection supplied by protocol/session behavior.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct SkillSelection {
    pub explicit: Vec<String>,
    pub disabled: Vec<String>,
}

/// Discovery result for a cwd scope.
#[derive(Debug, Clone, Default)]
pub struct SkillCatalog {
    pub cwd: PathBuf,
    pub roots: Vec<PathBuf>,
    pub skills: Vec<Skill>,
}

/// A resolved skill activation for one turn.
#[derive(Debug, Clone)]
pub struct SkillActivation {
    pub skill: Skill,
    pub reason: SkillActivationReason,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkillActivationReason {
    Explicit,
    Autoload,
    Keyword(String),
}

/// The skill work product consumed by prompt/message/inference assembly.
#[derive(Debug, Clone, Default)]
pub struct SkillInjectionPlan {
    pub activations: Vec<SkillActivation>,
    pub skill_index: String,
    pub prompt_blocks: Vec<String>,
    pub message_blocks: Vec<String>,
    pub inference_blocks: Vec<String>,
    pub provided_tool_skills: Vec<String>,
}

impl SkillInjectionPlan {
    pub fn is_empty(&self) -> bool {
        self.skill_index.trim().is_empty()
            && self.prompt_blocks.is_empty()
            && self.message_blocks.is_empty()
            && self.inference_blocks.is_empty()
            && self.provided_tool_skills.is_empty()
    }

    pub fn prompt_text(&self) -> String {
        self.prompt_blocks.join("\n\n")
    }

    pub fn message_text(&self) -> String {
        self.message_blocks.join("\n\n")
    }
}

/// Manages skill discovery, loading, and lifecycle.
pub struct SkillManager {
    /// Root directory containing skill subdirectories
    pub skills_dir: PathBuf,
    /// Cache of loaded skills keyed by name
    skills: HashMap<String, Skill>,
}

impl SkillManager {
    /// Create a new SkillManager pointing at the given skills directory.
    pub fn new(skills_dir: PathBuf) -> Self {
        Self {
            skills_dir,
            skills: HashMap::new(),
        }
    }

    /// Scan the skills directory and load all valid skills.
    ///
    /// Each subdirectory containing a `SKILL.md` file is treated as a skill.
    /// Skills with parse errors are logged and skipped.
    pub fn load_all(&mut self) -> Result<Vec<Skill>> {
        self.skills.clear();

        let entries = std::fs::read_dir(&self.skills_dir).map_err(|e| {
            Error::Config(format!(
                "Failed to read skills directory '{}': {}",
                self.skills_dir.display(),
                e
            ))
        })?;

        let mut loaded = Vec::new();

        for entry in entries {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };

            let path = entry.path();
            if !path.is_dir() {
                continue;
            }

            let skill_file = path.join("SKILL.md");
            if !skill_file.exists() {
                continue;
            }

            match load_skill(&path) {
                Ok(skill) => {
                    self.skills.insert(skill.name.clone(), skill.clone());
                    loaded.push(skill);
                }
                Err(_) => {
                    // Skip skills that fail to parse
                    continue;
                }
            }
        }

        Ok(loaded)
    }

    /// Get a specific skill by name.
    ///
    /// Returns `None` if the skill hasn't been loaded or doesn't exist.
    pub fn get(&self, name: &str) -> Option<&Skill> {
        self.skills.get(name)
    }

    /// List all loaded skills as `(name, description)` pairs.
    pub fn list(&self) -> Vec<(String, String)> {
        let mut pairs: Vec<_> = self
            .skills
            .values()
            .map(|s| (s.name.clone(), s.description.clone()))
            .collect();
        pairs.sort_by(|a, b| a.0.cmp(&b.0));
        pairs
    }

    /// Build a cwd-scoped catalog. Workspace-local roots closest to `cwd`
    /// override outer roots and the global root. This mirrors Hermes' two-step
    /// model: discover compact metadata first, then load full content only for
    /// activated skills.
    pub fn discover_for_cwd(&self, cwd: &Path) -> SkillCatalog {
        let mut roots = discover_skill_roots(cwd);
        roots.push(self.skills_dir.clone());

        let mut seen = std::collections::HashSet::new();
        let mut skills = Vec::new();
        for root in &roots {
            for skill in load_skills_from_root(root) {
                if seen.insert(skill.name.clone()) {
                    skills.push(skill);
                }
            }
        }
        skills.sort_by(|a, b| a.name.cmp(&b.name));
        roots.dedup();
        SkillCatalog {
            cwd: cwd.to_path_buf(),
            roots,
            skills,
        }
    }

    /// Resolve and build separated injections for one turn.
    pub fn resolve_for_turn(
        &self,
        turn: &TurnContext,
        selection: &SkillSelection,
    ) -> Result<SkillInjectionPlan> {
        let catalog = self.discover_for_cwd(&turn.cwd);
        let resolver = SkillResolver::default();
        resolver.resolve(&catalog, turn, selection, self)
    }

    /// Check whether a skill is available on the current platform
    /// and all prerequisites are met.
    pub fn is_available(&self, skill: &Skill) -> bool {
        // Check platform
        if !skill.platforms.is_empty() {
            let current = current_platform();
            if !skill.platforms.iter().any(|p| p == current) {
                return false;
            }
        }

        // Check required environment variables
        for var in &skill.prerequisites_env {
            if std::env::var(var).is_err() {
                return false;
            }
        }

        // Check required commands
        for cmd in &skill.prerequisites_commands {
            if !command_exists(cmd) {
                return false;
            }
        }

        true
    }

    /// Create a new skill with the given name and SKILL.md content.
    ///
    /// Creates a subdirectory under `skills_dir` with a `SKILL.md` file.
    pub fn create(&mut self, name: &str, content: &str) -> Result<()> {
        let skill_dir = self.skills_dir.join(name);

        if skill_dir.exists() {
            return Err(Error::Config(format!("Skill '{}' already exists", name)));
        }

        std::fs::create_dir_all(&skill_dir).map_err(|e| {
            Error::Config(format!(
                "Failed to create skill directory '{}': {}",
                skill_dir.display(),
                e
            ))
        })?;

        let skill_file = skill_dir.join("SKILL.md");
        std::fs::write(&skill_file, content).map_err(|e| {
            Error::Config(format!("Failed to write SKILL.md for '{}': {}", name, e))
        })?;

        // Reload the newly created skill into cache
        if let Ok(skill) = load_skill(&skill_dir) {
            self.skills.insert(skill.name.clone(), skill);
        }

        Ok(())
    }

    /// Delete a skill by removing its directory.
    pub fn delete(&mut self, name: &str) -> Result<()> {
        let skill_dir = self.skills_dir.join(name);

        if !skill_dir.exists() {
            return Err(Error::Config(format!("Skill '{}' not found", name)));
        }

        std::fs::remove_dir_all(&skill_dir)
            .map_err(|e| Error::Config(format!("Failed to delete skill '{}': {}", name, e)))?;

        self.skills.remove(name);
        Ok(())
    }
}

#[derive(Debug, Default, Clone)]
pub struct SkillResolver;

impl SkillResolver {
    pub fn resolve(
        &self,
        catalog: &SkillCatalog,
        turn: &TurnContext,
        selection: &SkillSelection,
        manager: &SkillManager,
    ) -> Result<SkillInjectionPlan> {
        let disabled: std::collections::HashSet<_> =
            selection.disabled.iter().map(|s| s.as_str()).collect();
        let mut by_name: HashMap<&str, &Skill> = HashMap::new();
        for skill in &catalog.skills {
            by_name.insert(skill.name.as_str(), skill);
        }

        let mut activations = Vec::new();
        let mut selected_names = std::collections::HashSet::new();

        for name in &selection.explicit {
            if disabled.contains(name.as_str()) {
                continue;
            }
            let Some(skill) = by_name.get(name.as_str()) else {
                return Err(Error::Config(format!("Skill '{}' not found", name)));
            };
            if !manager.is_available(skill) {
                return Err(Error::Config(format!("Skill '{}' is not available", name)));
            }
            selected_names.insert(skill.name.clone());
            activations.push(SkillActivation {
                skill: (*skill).clone(),
                reason: SkillActivationReason::Explicit,
            });
        }

        let prompt_lc = turn.prompt.to_lowercase();
        for skill in &catalog.skills {
            if selected_names.contains(&skill.name) || disabled.contains(skill.name.as_str()) {
                continue;
            }
            if !manager.is_available(skill) {
                continue;
            }
            if skill.autoload {
                selected_names.insert(skill.name.clone());
                activations.push(SkillActivation {
                    skill: skill.clone(),
                    reason: SkillActivationReason::Autoload,
                });
                continue;
            }
            if let Some(keyword) = skill
                .activation_keywords
                .iter()
                .find(|keyword| prompt_lc.contains(&keyword.to_lowercase()))
            {
                selected_names.insert(skill.name.clone());
                activations.push(SkillActivation {
                    skill: skill.clone(),
                    reason: SkillActivationReason::Keyword(keyword.clone()),
                });
            }
        }

        let mut plan = build_injection_plan(activations, Some(turn.session_id.as_str()));
        plan.skill_index = build_skill_index_prompt(catalog);
        Ok(plan)
    }
}

fn build_injection_plan(
    activations: Vec<SkillActivation>,
    session_id: Option<&str>,
) -> SkillInjectionPlan {
    let mut plan = SkillInjectionPlan {
        activations,
        ..SkillInjectionPlan::default()
    };

    for activation in &plan.activations {
        let skill = &activation.skill;
        let block = format_skill_invocation_block(skill, &activation.reason, session_id);
        match skill.injection_point {
            SkillInjectionPoint::Prompt => plan.prompt_blocks.push(block),
            SkillInjectionPoint::Message => plan.message_blocks.push(block),
            SkillInjectionPoint::Inference => plan.inference_blocks.push(block),
        }
        if skill.provides_tools {
            plan.provided_tool_skills.push(skill.name.clone());
        }
    }

    plan
}

pub fn build_skill_index_prompt(catalog: &SkillCatalog) -> String {
    if catalog.skills.is_empty() {
        return String::new();
    }

    let mut lines = Vec::new();
    for skill in &catalog.skills {
        if skill.description.trim().is_empty() {
            lines.push(format!("- {}", skill.name));
        } else {
            lines.push(format!("- {}: {}", skill.name, skill.description.trim()));
        }
    }

    format!(
        "## Skills\n\
         Cwd-scoped skills are available below. Load full skill bodies only when \
         selected for this turn; skills are context projections, not tools unless \
         explicitly declared as tool providers.\n\
         <available_skills cwd=\"{}\">\n{}\n</available_skills>",
        catalog.cwd.display(),
        lines.join("\n")
    )
}

fn format_skill_invocation_block(
    skill: &Skill,
    reason: &SkillActivationReason,
    session_id: Option<&str>,
) -> String {
    let reason = match reason {
        SkillActivationReason::Explicit => "explicit".to_string(),
        SkillActivationReason::Autoload => "autoload".to_string(),
        SkillActivationReason::Keyword(keyword) => format!("keyword:{keyword}"),
    };
    let content = preprocess_skill_content(&skill.content, &skill.skill_dir, session_id);
    let mut block = format!(
        "[IMPORTANT: The `{}` skill was activated for this turn ({reason}). \
         The full skill content is loaded below.]\n\n{}\n\n\
         [Skill directory: {}]\n\
         Resolve relative paths in this skill against that directory.",
        skill.name,
        content.trim(),
        skill.skill_dir.display()
    );
    if !skill.references.is_empty() {
        let mut refs: Vec<_> = skill.references.keys().cloned().collect();
        refs.sort();
        block.push_str("\n\n[This skill has supporting files:]\n");
        for path in refs {
            block.push_str(&format!("- {}\n", skill.skill_dir.join(&path).display()));
        }
    }
    if skill.provides_tools {
        block.push_str("\n[Runtime note: this skill explicitly declares provides_tools=true.]");
    }
    block
}

fn preprocess_skill_content(content: &str, skill_dir: &Path, session_id: Option<&str>) -> String {
    let content = content.replace("${HERMES_SKILL_DIR}", &skill_dir.display().to_string());
    if let Some(session_id) = session_id.filter(|value| !value.is_empty()) {
        content.replace("${HERMES_SESSION_ID}", session_id)
    } else {
        content
    }
}

fn discover_skill_roots(cwd: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let mut current = if cwd.is_file() {
        cwd.parent().unwrap_or(cwd).to_path_buf()
    } else {
        cwd.to_path_buf()
    };
    let git_root = find_git_root(&current);
    loop {
        for rel in WORKSPACE_SKILL_DIRS {
            let candidate = current.join(rel);
            if candidate.is_dir() {
                roots.push(candidate);
            }
        }
        if git_root.as_ref().is_some_and(|root| current == *root) {
            break;
        }
        match current.parent() {
            Some(parent) if parent != current => current = parent.to_path_buf(),
            _ => break,
        }
    }
    roots
}

fn find_git_root(start: &Path) -> Option<PathBuf> {
    let mut current = start.to_path_buf();
    loop {
        if current.join(".git").exists() {
            return Some(current);
        }
        match current.parent() {
            Some(parent) if parent != current => current = parent.to_path_buf(),
            _ => return None,
        }
    }
}

fn load_skills_from_root(root: &Path) -> Vec<Skill> {
    let mut skills = Vec::new();
    for skill_file in find_skill_files(root) {
        if let Some(path) = skill_file.parent() {
            match load_skill(path) {
                Ok(skill) => skills.push(skill),
                Err(error) => {
                    debug!(path = %path.display(), error = %error, "Could not load skill")
                }
            }
        }
    }
    skills
}

fn find_skill_files(root: &Path) -> Vec<PathBuf> {
    fn visit(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("");
            if name.starts_with('.') && name != ".agents" && name != ".codex" && name != ".hermes" {
                continue;
            }
            if path.is_file() && name == "SKILL.md" {
                out.push(path);
            } else if path.is_dir() {
                visit(&path, out);
            }
        }
    }

    let mut files = Vec::new();
    visit(root, &mut files);
    files.sort();
    files
}

/// Builds explicit skill prompt injections.
#[derive(Debug, Clone)]
pub struct SkillInjectionPlanner {
    pub skills_dir: PathBuf,
}

impl SkillInjectionPlanner {
    pub fn new(skills_dir: PathBuf) -> Self {
        Self { skills_dir }
    }

    pub fn build_explicit_injection(&self, names: &[String]) -> Result<String> {
        if names.is_empty() {
            return Ok(String::new());
        }
        let mut manager = SkillManager::new(self.skills_dir.clone());
        manager.load_all()?;
        let mut blocks = Vec::new();
        for name in names {
            let Some(skill) = manager.get(name) else {
                return Err(Error::Config(format!("Skill '{}' not found", name)));
            };
            if !manager.is_available(skill) {
                return Err(Error::Config(format!("Skill '{}' is not available", name)));
            }
            blocks.push(format!(
                "<skill name=\"{}\">\n{}\n</skill>",
                skill.name, skill.content
            ));
        }
        Ok(blocks.join("\n\n"))
    }
}

/// Prompt transform hook for explicit skill selection.
#[derive(Debug, Clone)]
pub struct SkillPromptHook {
    planner: SkillInjectionPlanner,
    selected: Vec<String>,
}

impl SkillPromptHook {
    pub fn new(skills_dir: PathBuf, selected: Vec<String>) -> Self {
        Self {
            planner: SkillInjectionPlanner::new(skills_dir),
            selected,
        }
    }
}

#[async_trait]
impl PromptTransformHook for SkillPromptHook {
    async fn transform_prompt(&self, prompt: String, _turn: &TurnContext) -> Result<String> {
        let injection = self.planner.build_explicit_injection(&self.selected)?;
        if injection.trim().is_empty() {
            Ok(prompt)
        } else {
            Ok(format!("{prompt}\n\n<skills>\n{injection}\n</skills>"))
        }
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Load a single skill from its directory.
fn load_skill(skill_dir: &Path) -> Result<Skill> {
    let dir_name = skill_dir
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| Error::Config("Invalid skill directory name".into()))?
        .to_string();

    let skill_file = skill_dir.join("SKILL.md");
    let raw = std::fs::read_to_string(&skill_file)
        .map_err(|e| Error::Config(format!("Failed to read SKILL.md in '{}': {}", dir_name, e)))?;

    let (front_matter, body) = parse_front_matter(&raw)?;

    let name = front_matter
        .get("name")
        .cloned()
        .unwrap_or_else(|| dir_name.clone());
    let description = front_matter.get("description").cloned().unwrap_or_default();
    let version = front_matter
        .get("version")
        .cloned()
        .unwrap_or_else(|| "0.1.0".into());
    let platforms = parse_list(front_matter.get("platforms"));
    let prerequisites_env = parse_list(front_matter.get("prerequisites_env"));
    let prerequisites_commands = parse_list(front_matter.get("prerequisites_commands"));
    let activation_keywords = parse_list(front_matter.get("activation_keywords"))
        .into_iter()
        .chain(parse_list(front_matter.get("keywords")))
        .collect();
    let autoload = parse_bool(front_matter.get("autoload")).unwrap_or(false);
    let provides_tools = parse_bool(front_matter.get("provides_tools")).unwrap_or(false);
    let injection_point = front_matter
        .get("injection")
        .or_else(|| front_matter.get("injection_point"))
        .map(|value| parse_injection_point(value))
        .transpose()?
        .unwrap_or_default();

    // Load reference files (everything in the skill dir that isn't SKILL.md)
    let mut references = HashMap::new();
    if let Ok(entries) = std::fs::read_dir(skill_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Some(fname) = path.file_name().and_then(|n| n.to_str()) {
                    if fname != "SKILL.md" {
                        if let Ok(content) = std::fs::read_to_string(&path) {
                            references.insert(fname.to_string(), content);
                        }
                    }
                }
            }
        }
    }

    Ok(Skill {
        name,
        description,
        version,
        content: body,
        platforms,
        prerequisites_env,
        prerequisites_commands,
        activation_keywords,
        autoload,
        provides_tools,
        injection_point,
        skill_dir: skill_dir.to_path_buf(),
        references,
    })
}

/// Parse YAML-like front matter delimited by `---` lines.
///
/// Returns a map of key-value pairs and the remaining body content.
/// Values that look like YAML lists (`[a, b, c]`) are stored as-is;
/// use `parse_list` to expand them.
fn parse_front_matter(raw: &str) -> Result<(HashMap<String, String>, String)> {
    let trimmed = raw.trim_start();

    if !trimmed.starts_with("---") {
        // No front matter — treat entire content as body, use defaults
        return Ok((HashMap::new(), raw.to_string()));
    }

    // Find the closing `---`
    let after_open = &trimmed[3..];
    let close_pos = after_open
        .find("\n---")
        .ok_or_else(|| Error::Config("SKILL.md front matter missing closing '---'".into()))?;

    let fm_block = &after_open[..close_pos];
    // Body starts after the closing `---` line
    let body_start = 3 + close_pos + 4; // "---" + "\n---"
    let body = if body_start < trimmed.len() {
        trimmed[body_start..].trim_start_matches('\n').to_string()
    } else {
        String::new()
    };

    let mut map = HashMap::new();

    for line in fm_block.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(colon_pos) = line.find(':') {
            let key = line[..colon_pos].trim().to_string();
            let value = line[colon_pos + 1..].trim().to_string();
            if !key.is_empty() {
                map.insert(key, value);
            }
        }
    }

    Ok((map, body))
}

/// Parse a YAML-like list value.
///
/// Supports both inline `[a, b, c]` and bare `a, b, c` formats.
/// Returns an empty vec for `None` or empty strings.
fn parse_list(value: Option<&String>) -> Vec<String> {
    let s = match value {
        Some(s) if !s.is_empty() => s,
        _ => return Vec::new(),
    };

    let s = s.trim();

    // Strip surrounding brackets if present
    let inner = if s.starts_with('[') && s.ends_with(']') {
        &s[1..s.len() - 1]
    } else {
        s
    };

    inner
        .split(',')
        .map(|item| item.trim().trim_matches('"').trim_matches('\'').to_string())
        .filter(|item| !item.is_empty())
        .collect()
}

fn parse_bool(value: Option<&String>) -> Option<bool> {
    let value = value?.trim().trim_matches('"').trim_matches('\'');
    match value.to_ascii_lowercase().as_str() {
        "true" | "yes" | "1" | "on" => Some(true),
        "false" | "no" | "0" | "off" => Some(false),
        _ => None,
    }
}

fn parse_injection_point(value: &str) -> Result<SkillInjectionPoint> {
    match value.trim().trim_matches('"').trim_matches('\'') {
        "prompt" | "system" | "system_prompt" => Ok(SkillInjectionPoint::Prompt),
        "message" | "turn_message" => Ok(SkillInjectionPoint::Message),
        "inference" | "request" | "model_request" => Ok(SkillInjectionPoint::Inference),
        other => Err(Error::Config(format!(
            "Unknown skill injection point '{}'",
            other
        ))),
    }
}

/// Return the current platform as a lowercase string matching common conventions.
fn current_platform() -> &'static str {
    if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "unknown"
    }
}

/// Check whether a command is available on the system PATH.
fn command_exists(cmd: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("where")
            .arg(cmd)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("which")
            .arg(cmd)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    use std::sync::atomic::{AtomicU64, Ordering};
    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn make_temp_dir() -> PathBuf {
        let count = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "hermes_skills_test_{}_{}",
            std::process::id(),
            count
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn cleanup(dir: &Path) {
        let _ = fs::remove_dir_all(dir);
    }

    fn minimal_skill(name: &str) -> Skill {
        Skill {
            name: name.into(),
            description: "test".into(),
            version: "1.0.0".into(),
            content: String::new(),
            platforms: vec![],
            prerequisites_env: vec![],
            prerequisites_commands: vec![],
            activation_keywords: vec![],
            autoload: false,
            provides_tools: false,
            injection_point: SkillInjectionPoint::Prompt,
            skill_dir: PathBuf::from("."),
            references: HashMap::new(),
        }
    }

    fn sample_skill_md() -> &'static str {
        "---\n\
         name: test-skill\n\
         description: A test skill for unit tests\n\
         version: 1.0.0\n\
         platforms: [linux, macos, windows]\n\
         prerequisites_env: [HOME]\n\
         prerequisites_commands: []\n\
         ---\n\
         # Test Skill\n\
         \n\
         This is the skill content.\n"
    }

    #[test]
    fn test_parse_front_matter() {
        let (fm, body) = parse_front_matter(sample_skill_md()).unwrap();
        assert_eq!(fm.get("name").unwrap(), "test-skill");
        assert_eq!(
            fm.get("description").unwrap(),
            "A test skill for unit tests"
        );
        assert_eq!(fm.get("version").unwrap(), "1.0.0");
        assert!(body.contains("# Test Skill"));
        assert!(body.contains("This is the skill content."));
    }

    #[test]
    fn test_parse_front_matter_no_front_matter() {
        let (fm, body) = parse_front_matter("# Just content\nNo front matter here").unwrap();
        assert!(fm.is_empty());
        assert!(body.contains("# Just content"));
    }

    #[test]
    fn test_parse_list_inline() {
        let val = "[linux, macos, windows]".to_string();
        let result = parse_list(Some(&val));
        assert_eq!(result, vec!["linux", "macos", "windows"]);
    }

    #[test]
    fn test_parse_list_bare() {
        let val = "linux, macos".to_string();
        let result = parse_list(Some(&val));
        assert_eq!(result, vec!["linux", "macos"]);
    }

    #[test]
    fn test_parse_list_empty() {
        assert!(parse_list(None).is_empty());
        let val = "[]".to_string();
        assert!(parse_list(Some(&val)).is_empty());
    }

    #[test]
    fn test_load_skill() {
        let tmp = make_temp_dir();
        let skill_dir = tmp.join("my-skill");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(skill_dir.join("SKILL.md"), sample_skill_md()).unwrap();
        fs::write(skill_dir.join("helper.py"), "print('hello')").unwrap();

        let skill = load_skill(&skill_dir).unwrap();
        assert_eq!(skill.name, "test-skill");
        assert_eq!(skill.version, "1.0.0");
        assert_eq!(skill.platforms, vec!["linux", "macos", "windows"]);
        assert!(skill.content.contains("# Test Skill"));
        assert_eq!(skill.references.get("helper.py").unwrap(), "print('hello')");

        cleanup(&tmp);
    }

    #[test]
    fn test_skill_manager_load_all() {
        let tmp = make_temp_dir();

        // Create two skills
        let s1 = tmp.join("skill-a");
        fs::create_dir_all(&s1).unwrap();
        fs::write(
            s1.join("SKILL.md"),
            "---\nname: skill-a\ndescription: First\nversion: 0.1.0\n---\nContent A\n",
        )
        .unwrap();

        let s2 = tmp.join("skill-b");
        fs::create_dir_all(&s2).unwrap();
        fs::write(
            s2.join("SKILL.md"),
            "---\nname: skill-b\ndescription: Second\nversion: 0.2.0\n---\nContent B\n",
        )
        .unwrap();

        // Create a non-skill directory (no SKILL.md)
        let s3 = tmp.join("not-a-skill");
        fs::create_dir_all(&s3).unwrap();
        fs::write(s3.join("README.md"), "nothing").unwrap();

        let mut mgr = SkillManager::new(tmp.clone());
        let loaded = mgr.load_all().unwrap();
        assert_eq!(loaded.len(), 2);

        let list = mgr.list();
        assert_eq!(list.len(), 2);
        assert!(list.iter().any(|(n, _)| n == "skill-a"));
        assert!(list.iter().any(|(n, _)| n == "skill-b"));

        assert!(mgr.get("skill-a").is_some());
        assert!(mgr.get("nonexistent").is_none());

        cleanup(&tmp);
    }

    #[test]
    fn test_skill_manager_create_and_delete() {
        let tmp = make_temp_dir();
        let mut mgr = SkillManager::new(tmp.clone());

        let content =
            "---\nname: new-skill\ndescription: Created skill\nversion: 1.0.0\n---\n# New\n";
        mgr.create("new-skill", content).unwrap();

        assert!(tmp.join("new-skill").join("SKILL.md").exists());
        assert!(mgr.get("new-skill").is_some());
        assert_eq!(mgr.get("new-skill").unwrap().description, "Created skill");

        // Creating duplicate should fail
        assert!(mgr.create("new-skill", content).is_err());

        // Delete
        mgr.delete("new-skill").unwrap();
        assert!(!tmp.join("new-skill").exists());
        assert!(mgr.get("new-skill").is_none());

        // Deleting non-existent should fail
        assert!(mgr.delete("new-skill").is_err());

        cleanup(&tmp);
    }

    #[test]
    fn test_is_available_platform_match() {
        let mut skill = minimal_skill("test");
        skill.platforms = vec![current_platform().to_string()];

        let mgr = SkillManager::new(PathBuf::from("."));
        assert!(mgr.is_available(&skill));
    }

    #[test]
    fn test_is_available_platform_mismatch() {
        let mut skill = minimal_skill("test");
        skill.platforms = vec!["plan9".to_string()];

        let mgr = SkillManager::new(PathBuf::from("."));
        assert!(!mgr.is_available(&skill));
    }

    #[test]
    fn test_is_available_empty_platforms_means_all() {
        let skill = minimal_skill("test");

        let mgr = SkillManager::new(PathBuf::from("."));
        assert!(mgr.is_available(&skill));
    }

    #[test]
    fn test_is_available_missing_env() {
        let mut skill = minimal_skill("test");
        skill.prerequisites_env = vec!["HERMES_NONEXISTENT_VAR_12345".into()];

        let mgr = SkillManager::new(PathBuf::from("."));
        assert!(!mgr.is_available(&skill));
    }

    #[test]
    fn test_load_skill_defaults() {
        let tmp = make_temp_dir();
        let skill_dir = tmp.join("minimal");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            "# Just content, no front matter\n",
        )
        .unwrap();

        let skill = load_skill(&skill_dir).unwrap();
        // Name falls back to directory name
        assert_eq!(skill.name, "minimal");
        assert_eq!(skill.version, "0.1.0");
        assert!(skill.platforms.is_empty());
        assert!(skill.content.contains("# Just content"));

        cleanup(&tmp);
    }

    #[test]
    fn test_skill_injection_planner_explicit_selection() {
        let tmp = make_temp_dir();
        let skill_dir = tmp.join("skill-a");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: skill-a\ndescription: First\nversion: 0.1.0\n---\nUse skill A.\n",
        )
        .unwrap();

        let planner = SkillInjectionPlanner::new(tmp.clone());
        let injection = planner
            .build_explicit_injection(&["skill-a".to_string()])
            .unwrap();

        assert!(injection.contains("<skill name=\"skill-a\">"));
        assert!(injection.contains("Use skill A."));

        cleanup(&tmp);
    }

    #[test]
    fn discover_for_cwd_prefers_nearest_workspace_skill() {
        let tmp = make_temp_dir();
        fs::create_dir(tmp.join(".git")).unwrap();
        let root_skills = tmp.join(".agents").join("skills").join("shared");
        fs::create_dir_all(&root_skills).unwrap();
        fs::write(
            root_skills.join("SKILL.md"),
            "---\nname: shared\ndescription: root\n---\nroot skill\n",
        )
        .unwrap();

        let nested = tmp.join("packages").join("api");
        fs::create_dir_all(&nested).unwrap();
        let nested_skills = nested.join(".agents").join("skills").join("shared");
        fs::create_dir_all(&nested_skills).unwrap();
        fs::write(
            nested_skills.join("SKILL.md"),
            "---\nname: shared\ndescription: nested\n---\nnested skill\n",
        )
        .unwrap();
        let nested_category_skill = nested
            .join(".agents")
            .join("skills")
            .join("coding")
            .join("rusty");
        fs::create_dir_all(&nested_category_skill).unwrap();
        fs::write(
            nested_category_skill.join("SKILL.md"),
            "---\nname: rusty\ndescription: recursive\n---\nrust skill\n",
        )
        .unwrap();

        let manager = SkillManager::new(tmp.join("global-skills"));
        let catalog = manager.discover_for_cwd(&nested);

        let shared: Vec<_> = catalog
            .skills
            .iter()
            .filter(|skill| skill.name == "shared")
            .collect();
        assert_eq!(shared.len(), 1);
        assert_eq!(shared[0].description, "nested");
        assert!(shared[0].content.contains("nested skill"));
        assert!(catalog.skills.iter().any(|skill| skill.name == "rusty"));

        cleanup(&tmp);
    }

    #[test]
    fn resolve_for_turn_separates_prompt_message_and_inference_injections() {
        let tmp = make_temp_dir();
        let skills_root = tmp.join(".agents").join("skills");
        for (name, injection) in [
            ("prompt-skill", "prompt"),
            ("message-skill", "message"),
            ("inference-skill", "inference"),
        ] {
            let dir = skills_root.join(name);
            fs::create_dir_all(&dir).unwrap();
            fs::write(
                dir.join("SKILL.md"),
                format!(
                    "---\nname: {name}\nautoload: true\ninjection: {injection}\n---\n{name} body\n"
                ),
            )
            .unwrap();
        }

        let manager = SkillManager::new(tmp.join("global-skills"));
        let turn = TurnContext {
            turn_id: "turn_1".to_string(),
            run_id: "run_1".to_string(),
            session_id: "session_1".to_string(),
            source: "prompt".to_string(),
            prompt: "hello".to_string(),
            cwd: tmp.clone(),
            versions: crate::behavior::BehaviorVersions::default(),
            skills: SkillSelection::default(),
        };

        let plan = manager
            .resolve_for_turn(&turn, &SkillSelection::default())
            .expect("skill plan");

        assert!(plan.prompt_text().contains("prompt-skill body"));
        assert!(plan.message_text().contains("message-skill body"));
        assert!(plan.skill_index.contains("prompt-skill"));
        assert!(plan.skill_index.contains("message-skill"));
        assert!(plan.skill_index.contains("inference-skill"));
        assert!(plan
            .inference_blocks
            .iter()
            .any(|block| block.contains("inference-skill body")));

        cleanup(&tmp);
    }

    #[test]
    fn skills_default_to_message_scaffold_and_template_substitution() {
        let tmp = make_temp_dir();
        let skill_dir = tmp.join(".agents").join("skills").join("templated");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: templated\nautoload: true\n---\nSession ${HERMES_SESSION_ID} runs ${HERMES_SKILL_DIR}/scripts/setup.sh; missing ${HERMES_UNKNOWN}\n",
        )
        .unwrap();

        let manager = SkillManager::new(tmp.join("global-skills"));
        let turn = TurnContext {
            turn_id: "turn_1".to_string(),
            run_id: "run_1".to_string(),
            session_id: "session_abc".to_string(),
            source: "prompt".to_string(),
            prompt: "hello".to_string(),
            cwd: tmp.clone(),
            versions: crate::behavior::BehaviorVersions::default(),
            skills: SkillSelection::default(),
        };

        let plan = manager
            .resolve_for_turn(&turn, &SkillSelection::default())
            .expect("skill plan");

        assert!(plan.prompt_text().is_empty());
        assert!(plan.message_text().contains("[IMPORTANT:"));
        assert!(plan
            .message_text()
            .contains(&skill_dir.display().to_string()));
        assert!(plan.message_text().contains("Session session_abc runs"));
        assert!(plan.message_text().contains("/scripts/setup.sh"));
        assert!(plan.message_text().contains("${HERMES_UNKNOWN}"));

        cleanup(&tmp);
    }

    #[test]
    fn skill_is_not_tool_provider_unless_declared() {
        let tmp = make_temp_dir();
        let skill_dir = tmp.join(".agents").join("skills").join("plain");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: plain\nautoload: true\n---\nplain body\n",
        )
        .unwrap();
        let tool_skill_dir = tmp.join(".agents").join("skills").join("toolish");
        fs::create_dir_all(&tool_skill_dir).unwrap();
        fs::write(
            tool_skill_dir.join("SKILL.md"),
            "---\nname: toolish\nautoload: true\nprovides_tools: true\n---\ntoolish body\n",
        )
        .unwrap();

        let manager = SkillManager::new(tmp.join("global-skills"));
        let turn = TurnContext {
            turn_id: "turn_1".to_string(),
            run_id: "run_1".to_string(),
            session_id: "session_1".to_string(),
            source: "prompt".to_string(),
            prompt: "hello".to_string(),
            cwd: tmp.clone(),
            versions: crate::behavior::BehaviorVersions::default(),
            skills: SkillSelection::default(),
        };

        let plan = manager
            .resolve_for_turn(&turn, &SkillSelection::default())
            .expect("skill plan");

        assert_eq!(plan.provided_tool_skills, vec!["toolish"]);

        cleanup(&tmp);
    }
}
