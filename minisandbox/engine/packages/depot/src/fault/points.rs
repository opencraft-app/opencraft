#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum DepotFaultPoint {
	Commit(CommitFaultPoint),
	Read(ReadFaultPoint),
	HotCompaction(HotCompactionFaultPoint),
	ColdCompaction(ColdCompactionFaultPoint),
	Reclaim(ReclaimFaultPoint),
	BranchGc(BranchGcFaultPoint),
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum FaultBoundary {
	PreDurableCommit,
	AmbiguousAfterDurableCommit,
	PostDurableNonData,
	ReadOnly,
	WorkflowOnly,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum CommitFaultPoint {
	BeforeTx,
	AfterBranchResolution,
	AfterHeadRead,
	AfterTruncateCleanup,
	AfterLtxEncode,
	BeforeDeltaWrites,
	BeforePidxWrites,
	BeforeHeadWrite,
	BeforeCommitRows,
	BeforeQuotaMutation,
	AfterUdbCommit,
	BeforeCompactionSignal,
	AfterCompactionSignal,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum ReadFaultPoint {
	BeforeScopeResolve,
	AfterScopeResolve,
	AfterPidxScan,
	DeltaBlobMissing,
	AfterDeltaBlobLoad,
	AfterShardBlobLoad,
	BeforeReturnPages,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum HotCompactionFaultPoint {
	StageBeforeAdmission,
	StageBeforeInputRead,
	StageAfterInputRead,
	StageAfterShardBatchFdbCommit,
	StageAfterShardWrite,
	AfterStageBeforeFinishSignal,
	InstallBeforeShardIntegrityPreflight,
	InstallBeforeStagedRead,
	InstallAfterStagedRead,
	InstallBeforeShardPublish,
	InstallAfterShardPublishBeforePidxClear,
	InstallBeforeRootUpdate,
	InstallAfterRootUpdate,
	InstallAfterFdbCommit,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum ColdCompactionFaultPoint {
	UploadAfterObjectPut,
	PublishAfterFdbCommit,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum ReclaimFaultPoint {
	PlanBeforeSnapshot,
	PlanAfterSnapshot,
	BeforeHotDelete,
	AfterHotDelete,
	BeforeCleanupRows,
	BeforeColdDeleteIssuedCommit,
	AfterColdDeleteIssuedCommit,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum BranchGcFaultPoint {
	AfterColdObjectDelete,
}

impl DepotFaultPoint {
	pub fn boundary(&self) -> FaultBoundary {
		match self {
			DepotFaultPoint::Commit(point) => point.boundary(),
			DepotFaultPoint::Read(point) => point.boundary(),
			DepotFaultPoint::HotCompaction(point) => point.boundary(),
			DepotFaultPoint::ColdCompaction(point) => point.boundary(),
			DepotFaultPoint::Reclaim(point) => point.boundary(),
			DepotFaultPoint::BranchGc(point) => point.boundary(),
		}
	}
}

impl CommitFaultPoint {
	pub fn boundary(&self) -> FaultBoundary {
		match self {
			CommitFaultPoint::BeforeTx
			| CommitFaultPoint::AfterBranchResolution
			| CommitFaultPoint::AfterHeadRead
			| CommitFaultPoint::AfterTruncateCleanup
			| CommitFaultPoint::AfterLtxEncode
			| CommitFaultPoint::BeforeDeltaWrites
			| CommitFaultPoint::BeforePidxWrites
			| CommitFaultPoint::BeforeHeadWrite
			| CommitFaultPoint::BeforeCommitRows
			| CommitFaultPoint::BeforeQuotaMutation => FaultBoundary::PreDurableCommit,
			CommitFaultPoint::AfterUdbCommit => FaultBoundary::AmbiguousAfterDurableCommit,
			CommitFaultPoint::BeforeCompactionSignal | CommitFaultPoint::AfterCompactionSignal => {
				FaultBoundary::PostDurableNonData
			}
		}
	}
}

impl ReadFaultPoint {
	pub fn boundary(&self) -> FaultBoundary {
		match self {
			ReadFaultPoint::BeforeScopeResolve
			| ReadFaultPoint::AfterScopeResolve
			| ReadFaultPoint::AfterPidxScan
			| ReadFaultPoint::DeltaBlobMissing
			| ReadFaultPoint::AfterDeltaBlobLoad
			| ReadFaultPoint::AfterShardBlobLoad
			| ReadFaultPoint::BeforeReturnPages => FaultBoundary::ReadOnly,
		}
	}
}

impl HotCompactionFaultPoint {
	pub fn boundary(&self) -> FaultBoundary {
		match self {
			HotCompactionFaultPoint::StageAfterShardBatchFdbCommit
			| HotCompactionFaultPoint::InstallAfterFdbCommit => FaultBoundary::AmbiguousAfterDurableCommit,
			HotCompactionFaultPoint::StageBeforeAdmission
			| HotCompactionFaultPoint::StageBeforeInputRead
			| HotCompactionFaultPoint::StageAfterInputRead
			| HotCompactionFaultPoint::StageAfterShardWrite
			| HotCompactionFaultPoint::AfterStageBeforeFinishSignal
			| HotCompactionFaultPoint::InstallBeforeShardIntegrityPreflight
			| HotCompactionFaultPoint::InstallBeforeStagedRead
			| HotCompactionFaultPoint::InstallAfterStagedRead
			| HotCompactionFaultPoint::InstallBeforeShardPublish
			| HotCompactionFaultPoint::InstallAfterShardPublishBeforePidxClear
			| HotCompactionFaultPoint::InstallBeforeRootUpdate
			| HotCompactionFaultPoint::InstallAfterRootUpdate => FaultBoundary::WorkflowOnly,
		}
	}
}

impl ColdCompactionFaultPoint {
	pub fn boundary(&self) -> FaultBoundary {
		match self {
			ColdCompactionFaultPoint::UploadAfterObjectPut
			| ColdCompactionFaultPoint::PublishAfterFdbCommit => FaultBoundary::WorkflowOnly,
		}
	}
}

impl ReclaimFaultPoint {
	pub fn boundary(&self) -> FaultBoundary {
		match self {
			ReclaimFaultPoint::PlanBeforeSnapshot
			| ReclaimFaultPoint::PlanAfterSnapshot
			| ReclaimFaultPoint::BeforeHotDelete
			| ReclaimFaultPoint::AfterHotDelete
			| ReclaimFaultPoint::BeforeCleanupRows
			| ReclaimFaultPoint::BeforeColdDeleteIssuedCommit => FaultBoundary::PreDurableCommit,
			ReclaimFaultPoint::AfterColdDeleteIssuedCommit => {
				FaultBoundary::AmbiguousAfterDurableCommit
			}
		}
	}
}

impl BranchGcFaultPoint {
	pub fn boundary(&self) -> FaultBoundary {
		match self {
			BranchGcFaultPoint::AfterColdObjectDelete => FaultBoundary::WorkflowOnly,
		}
	}
}
