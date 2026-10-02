use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DirtyPage {
	pub pgno: u32,
	pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FetchedPage {
	pub pgno: u32,
	pub bytes: Option<Vec<u8>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GetPagesResult {
	pub pages: Vec<FetchedPage>,
	pub head_txid: u64,
	pub db_size_pages: u32,
	pub provenance: Vec<PageSourceProvenance>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DepotReadMode {
	#[default]
	Serving,
	DiagnosticNoSideEffects,
}

impl DepotReadMode {
	pub fn allows_side_effects(self) -> bool {
		match self {
			Self::Serving => true,
			Self::DiagnosticNoSideEffects => false,
		}
	}
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GetPagesOptions {
	pub expected_head_txid: Option<u64>,
	/// Also return the overflow pages referenced by any requested leaf page so a
	/// scanning client does not round trip once per overflowing row.
	pub expand_overflow: bool,
	/// Optional caller-specific cap on overflow pages appended to the response.
	/// Depot also enforces its own hard ceiling. Protocol frontends use this to
	/// keep the serialized response within their negotiated payload limit.
	pub max_overflow_pages: Option<usize>,
	pub mode: DepotReadMode,
	pub collect_provenance: bool,
	pub diagnostic_max_txid: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageSourceProvenance {
	pub pgno: u32,
	pub winner_kind: PageSourceKind,
	pub winner_txid: Option<u64>,
	pub winner_shard_id: Option<u32>,
	pub candidates: Vec<PageSourceCandidate>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageSourceCandidate {
	pub kind: PageSourceKind,
	pub txid: Option<u64>,
	pub shard_id: Option<u32>,
	pub result: PageSourceCandidateResult,
	pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PageSourceKind {
	PidxDelta,
	HistoricalDelta,
	MissingDelta,
	StaleDelta,
	HotShard,
	ColdShard,
	ZeroFill,
	OutOfRange,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PageSourceCandidateResult {
	Won,
	Lost,
	Selected,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitOptions {
	pub expected_head_txid: Option<u64>,
	/// Actor generation that is authorized to write this database. Databases configured with a
	/// writer fence reject commits that omit this value or do not match the authoritative owner
	/// generation read in the commit transaction.
	pub expected_writer_generation: Option<u64>,
	/// Stable identity for one logical SQLite commit. Reusing this identity with the exact same
	/// request returns the first durable result instead of advancing the branch twice.
	pub commit_attempt_id: Option<[u8; 16]>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitResult {
	pub head_txid: u64,
	pub db_size_pages: u32,
}
