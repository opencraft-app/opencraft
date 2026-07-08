//! Lazy subdirectory context hints for filesystem-oriented tool calls.
//!
//! The turn system prompt already carries the current cwd context. Context
//! hints add only the extra guidance discovered when a tool first enters a
//! deeper subdirectory. The module is split by ownership so future agents can
//! reason about scanner, policy, state, and result augmentation independently.

mod augmentor;
mod policy;
mod scanner;
mod tracker;

pub use augmentor::ToolResultAugmentor;
pub use policy::HintInjectionPolicy;
pub use scanner::{ContextHintBatch, HintFile, HintFileScanner};
pub use tracker::ContextHintTracker;

pub type SubdirectoryContextHintTracker = ContextHintTracker;
