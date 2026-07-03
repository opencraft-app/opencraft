use serde::{Deserialize, Serialize};

use crate::BackendKind;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum UserMessageBlock {
    Text { text: String },
    SkillRef {
        name: String,
        protocol: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        backend: Option<BackendKind>,
        #[serde(skip_serializing_if = "Option::is_none")]
        path: Option<String>,
    },
    Image { blob: BlobRef },
}

impl UserMessageBlock {
    pub fn text(text: impl Into<String>) -> Self {
        Self::Text { text: text.into() }
    }

    pub fn skill_ref(
        name: impl Into<String>,
        protocol: impl Into<String>,
        backend: Option<BackendKind>,
        path: Option<String>,
    ) -> Self {
        Self::SkillRef {
            name: name.into(),
            protocol: protocol.into(),
            backend,
            path,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BlobRef {
    InlineBase64 {
        data: String,
        mime_type: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        sha256: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        size_bytes: Option<u64>,
    },
    Stored {
        blob_id: String,
        mime_type: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        sha256: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        size_bytes: Option<u64>,
    },
}
