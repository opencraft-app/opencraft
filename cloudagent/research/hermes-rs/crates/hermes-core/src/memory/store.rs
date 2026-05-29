use std::collections::HashMap;
use std::path::PathBuf;

use super::{MemoryBlock, UserProfile};

/// File-backed storage for persisting memories to MEMORY.md and user profiles to USER.md,
/// using the `§` (section sign) delimiter between entries to match the Python hermes-agent format.
#[derive(Debug, Clone)]
pub struct MemoryStore {
    /// Directory containing MEMORY.md and USER.md.
    pub dir: PathBuf,
}

impl MemoryStore {
    /// Create a new MemoryStore pointing at the given directory.
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    /// Path to MEMORY.md.
    pub fn memory_path(&self) -> PathBuf {
        self.dir.join("MEMORY.md")
    }

    /// Path to USER.md.
    pub fn user_path(&self) -> PathBuf {
        self.dir.join("USER.md")
    }

    /// Serialize memories to MEMORY.md format using `§` delimiter.
    pub fn serialize_memories(memories: &HashMap<String, MemoryBlock>) -> String {
        let mut out = String::new();
        let mut entries: Vec<_> = memories.iter().collect();
        entries.sort_by(|a, b| a.0.cmp(b.0));

        for (_, block) in entries {
            out.push_str(&format!(
                "\u{00A7} [id: {}, type: {}, importance: {}",
                block.id, block.block_type, block.importance
            ));
            if !block.tags.is_empty() {
                out.push_str(&format!(", tags: {}", block.tags.join(",")));
            }
            out.push_str(&format!(
                ", created_at: {}, last_accessed: {}]\n",
                block.created_at, block.last_accessed
            ));
            out.push_str(&block.content);
            out.push('\n');
        }
        out
    }

    /// Parse MEMORY.md content into memory blocks.
    pub fn deserialize_memories(content: &str) -> HashMap<String, MemoryBlock> {
        let mut memories = HashMap::new();

        for section in content.split('\u{00A7}') {
            let section = section.trim();
            if section.is_empty() {
                continue;
            }

            let Some(header_start) = section.find('[') else {
                continue;
            };
            let Some(header_end) = section.find(']') else {
                continue;
            };

            let header = &section[header_start + 1..header_end];
            let body = section[header_end + 1..].trim().to_string();

            let mut id = String::new();
            let mut block_type = String::new();
            let mut importance: u8 = 50;
            let mut tags: Vec<String> = Vec::new();
            let mut created_at: i64 = 0;
            let mut last_accessed: i64 = 0;

            for part in header.split(", ") {
                let part = part.trim();
                if let Some(colon_pos) = part.find(": ") {
                    let key = part[..colon_pos].trim();
                    let value = &part[colon_pos + 2..];
                    match key {
                        "id" => id = value.to_string(),
                        "type" => block_type = value.to_string(),
                        "importance" => importance = value.parse().unwrap_or(50),
                        "tags" => {
                            tags = value
                                .split(',')
                                .map(|s| s.trim().to_string())
                                .filter(|s| !s.is_empty())
                                .collect();
                        }
                        "created_at" => created_at = value.parse().unwrap_or(0),
                        "last_accessed" => last_accessed = value.parse().unwrap_or(0),
                        _ => {}
                    }
                }
            }

            if id.is_empty() {
                continue;
            }

            memories.insert(
                id.clone(),
                MemoryBlock {
                    id,
                    block_type,
                    content: body,
                    importance,
                    created_at,
                    last_accessed,
                    tags,
                },
            );
        }

        memories
    }

    /// Write memories to MEMORY.md.
    pub fn write_memories(&self, memories: &HashMap<String, MemoryBlock>) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        let content = Self::serialize_memories(memories);
        std::fs::write(self.memory_path(), content)
    }

    /// Read memories from MEMORY.md.
    pub fn read_memories(&self) -> std::io::Result<HashMap<String, MemoryBlock>> {
        let content = std::fs::read_to_string(self.memory_path())?;
        Ok(Self::deserialize_memories(&content))
    }

    /// Serialize user profiles to USER.md format using `§` delimiter.
    pub fn serialize_profiles(profiles: &HashMap<String, UserProfile>) -> String {
        let mut out = String::new();
        let mut entries: Vec<_> = profiles.iter().collect();
        entries.sort_by(|a, b| a.0.cmp(b.0));

        for (_, profile) in entries {
            out.push_str(&format!("\u{00A7} [user_id: {}", profile.user_id));
            if let Some(ref name) = profile.name {
                out.push_str(&format!(", name: {}", name));
            }
            out.push_str("]\n");

            if !profile.preferences.is_empty() {
                out.push_str("Preferences:\n");
                let mut prefs: Vec<_> = profile.preferences.iter().collect();
                prefs.sort_by(|a, b| a.0.cmp(b.0));
                for (key, value) in prefs {
                    out.push_str(&format!("  {}: {}\n", key, value));
                }
            }

            if !profile.facts.is_empty() {
                out.push_str("Facts:\n");
                for fact in &profile.facts {
                    out.push_str(&format!("  [{}] {}\n", fact.block_type, fact.content));
                }
            }
        }
        out
    }

    /// Parse USER.md content into user profiles.
    pub fn deserialize_profiles(content: &str) -> HashMap<String, UserProfile> {
        let mut profiles = HashMap::new();

        for section in content.split('\u{00A7}') {
            let section = section.trim();
            if section.is_empty() {
                continue;
            }

            let Some(header_start) = section.find('[') else {
                continue;
            };
            let Some(header_end) = section.find(']') else {
                continue;
            };

            let header = &section[header_start + 1..header_end];
            let body = section[header_end + 1..].trim();

            let mut user_id = String::new();
            let mut name: Option<String> = None;

            for part in header.split(", ") {
                let part = part.trim();
                if let Some(colon_pos) = part.find(": ") {
                    let key = part[..colon_pos].trim();
                    let value = part[colon_pos + 2..].trim();
                    match key {
                        "user_id" => user_id = value.to_string(),
                        "name" => name = Some(value.to_string()),
                        _ => {}
                    }
                }
            }

            if user_id.is_empty() {
                continue;
            }

            let mut preferences = HashMap::new();
            let mut facts = Vec::new();
            let mut current_section = "";

            for line in body.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if trimmed == "Preferences:" {
                    current_section = "preferences";
                } else if trimmed == "Facts:" {
                    current_section = "facts";
                } else if !current_section.is_empty() {
                    match current_section {
                        "preferences" => {
                            if let Some(colon_pos) = trimmed.find(": ") {
                                let key = trimmed[..colon_pos].to_string();
                                let value = trimmed[colon_pos + 2..].to_string();
                                preferences.insert(key, value);
                            }
                        }
                        "facts" if trimmed.starts_with('[') => {
                            if let Some(bracket_end) = trimmed.find(']') {
                                let fact_type = trimmed[1..bracket_end].to_string();
                                let fact_content = trimmed[bracket_end + 1..].trim().to_string();
                                facts.push(MemoryBlock::new(
                                    format!("{}_{}", user_id, facts.len()),
                                    fact_type,
                                    fact_content,
                                ));
                            }
                        }
                        _ => {}
                    }
                }
            }

            profiles.insert(
                user_id.clone(),
                UserProfile {
                    user_id,
                    name,
                    preferences,
                    facts,
                },
            );
        }

        profiles
    }

    /// Write profiles to USER.md.
    pub fn write_profiles(&self, profiles: &HashMap<String, UserProfile>) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        let content = Self::serialize_profiles(profiles);
        std::fs::write(self.user_path(), content)
    }

    /// Read profiles from USER.md.
    pub fn read_profiles(&self) -> std::io::Result<HashMap<String, UserProfile>> {
        let content = std::fs::read_to_string(self.user_path())?;
        Ok(Self::deserialize_profiles(&content))
    }
}
