pub mod generated;
pub mod util;
pub mod versioned;

// Re-export latest
pub use generated::v7::*;

pub use generated::PROTOCOL_VERSION;

/// Maximum number of actor command checkpoints carried by one acknowledgement.
///
/// The server clears all acknowledged command ranges in one database transaction, so this is a
/// protocol cost bound rather than merely a client batching preference. It intentionally matches
/// the durable command reconciler page size.
pub const MAX_COMMAND_ACK_CHECKPOINTS: usize = 512;
