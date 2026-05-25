use serde::{Deserialize, Serialize};
use std::collections::HashMap;

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// A memory block that can be injected into context.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryBlock {
    /// Unique identifier for this memory.
    pub id: String,
    /// Type of memory (e.g., "user_profile", "session_summary", "fact").
    pub block_type: String,
    /// The actual content.
    pub content: String,
    /// Importance score (0-100).
    pub importance: u8,
    /// When this memory was created.
    pub created_at: i64,
    /// When this memory was last accessed.
    pub last_accessed: i64,
    /// Tags for categorization.
    pub tags: Vec<String>,
}

impl MemoryBlock {
    /// Create a new memory block.
    pub fn new(
        id: impl Into<String>,
        block_type: impl Into<String>,
        content: impl Into<String>,
    ) -> Self {
        let now = now_secs();

        Self {
            id: id.into(),
            block_type: block_type.into(),
            content: content.into(),
            importance: 50,
            created_at: now,
            last_accessed: now,
            tags: Vec::new(),
        }
    }

    /// Set importance score.
    pub fn importance(mut self, score: u8) -> Self {
        self.importance = score.min(100);
        self
    }

    /// Add tags.
    pub fn tags(mut self, tags: Vec<String>) -> Self {
        self.tags = tags;
        self
    }

    /// Update last accessed time.
    pub fn touch(&mut self) {
        self.last_accessed = now_secs();
    }
}

/// User profile stored in memory.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserProfile {
    /// User's unique identifier.
    pub user_id: String,
    /// User's display name.
    pub name: Option<String>,
    /// User's preferences.
    pub preferences: HashMap<String, String>,
    /// Known facts about the user.
    pub facts: Vec<MemoryBlock>,
}

impl Default for UserProfile {
    fn default() -> Self {
        Self {
            user_id: "default".to_string(),
            name: None,
            preferences: HashMap::new(),
            facts: Vec::new(),
        }
    }
}

/// Session information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    /// Unique session identifier.
    pub id: String,
    /// Session title (auto-generated or user-provided).
    pub title: String,
    /// Creation timestamp.
    pub created_at: i64,
    /// Last activity timestamp.
    pub last_activity: i64,
    /// Message count in this session.
    pub message_count: usize,
    /// Total tokens used.
    pub total_tokens: usize,
    /// Whether this session is archived.
    pub archived: bool,
}

impl Session {
    /// Create a new session.
    pub fn new(id: impl Into<String>, title: impl Into<String>) -> Self {
        let now = now_secs();

        Self {
            id: id.into(),
            title: title.into(),
            created_at: now,
            last_activity: now,
            message_count: 0,
            total_tokens: 0,
            archived: false,
        }
    }

    /// Update last activity timestamp.
    pub fn touch(&mut self) {
        self.last_activity = now_secs();
    }

    /// Increment message count.
    pub fn add_message(&mut self, tokens: usize) {
        self.message_count += 1;
        self.total_tokens += tokens;
        self.touch();
    }
}
