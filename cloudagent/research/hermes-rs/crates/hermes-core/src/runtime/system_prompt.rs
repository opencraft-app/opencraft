use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct SystemPromptLayers {
    pub stable: String,
    pub context: String,
    pub volatile: String,
}

impl SystemPromptLayers {
    pub fn cache_key(&self) -> SystemPromptCacheKey {
        SystemPromptCacheKey {
            stable_hash: hash_text(&self.stable),
            context_hash: hash_text(&self.context),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct SystemPromptCacheKey {
    stable_hash: u64,
    context_hash: u64,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct SystemPromptCache {
    entries: HashMap<SystemPromptCacheKey, String>,
    hits: usize,
    misses: usize,
}

impl SystemPromptCache {
    pub fn render(&mut self, layers: &SystemPromptLayers) -> String {
        let key = layers.cache_key();
        let stable_context = match self.entries.get(&key) {
            Some(rendered) => {
                self.hits += 1;
                rendered.clone()
            }
            None => {
                self.misses += 1;
                let rendered = join_non_empty([layers.stable.as_str(), layers.context.as_str()]);
                self.entries.insert(key, rendered.clone());
                rendered
            }
        };

        join_non_empty([stable_context.as_str(), layers.volatile.as_str()])
    }

    #[cfg(test)]
    pub fn stats(&self) -> SystemPromptCacheStats {
        SystemPromptCacheStats {
            entries: self.entries.len(),
            hits: self.hits,
            misses: self.misses,
        }
    }
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SystemPromptCacheStats {
    pub entries: usize,
    pub hits: usize,
    pub misses: usize,
}

fn join_non_empty<'a>(parts: impl IntoIterator<Item = &'a str>) -> String {
    parts
        .into_iter()
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn hash_text(value: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    value.hash(&mut hasher);
    hasher.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn volatile_layer_does_not_change_cache_key() {
        let first = SystemPromptLayers {
            stable: "stable".to_string(),
            context: "context".to_string(),
            volatile: "time one".to_string(),
        };
        let second = SystemPromptLayers {
            volatile: "time two".to_string(),
            ..first.clone()
        };

        assert_eq!(first.cache_key(), second.cache_key());
    }
}
