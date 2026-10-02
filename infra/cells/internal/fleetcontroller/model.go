package fleetcontroller

import (
	"sort"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

const (
	Group                  = "fleet.actor.dev"
	Version                = "v1alpha1"
	ControllerName         = "fleet.actor.dev/rivet-fdb-cos"
	PoolLabel              = "fleet.actor.dev/pool"
	RetirementFinalizer    = "fleet.actor.dev/retirement-protection"
	DefaultReportFreshness = 2 * time.Minute
)

type CellInput struct {
	Name                  string
	UID                   string
	Generation            int64
	DesiredState          string
	RetirementGeneration  int64
	ClusterIdentityHash   string
	ProfileDigest         string
	ProfileSpecDigest     string
	ProfileConforming     bool
	ProductionEligible    bool
	MinRuntimeReadyHosts  int64
	TopologyConforming    bool
	FDBOperatorRequired   bool
	FDBOperatorFound      bool
	FDBOperatorReady      bool
	FDBOperatorReason     string
	FDBOperatorMessage    string
	Report                *CellReport
	ExistingConditions    []metav1.Condition
	Now                   time.Time
	ReportFreshness       time.Duration
	CapacityPolicy        CellCapacityPolicy
	ExistingCapacityRisk  string
	ExistingScaleOutEpoch int64
	FDBAutoscalingPolicy  FDBAutoscalingPolicy
	FDBAutoscalingStatus  FDBAutoscalingStatus
	InitialFDBProcesses   int64
	ObservedFDBProcesses  int64
}

type CellCapacityPolicy struct {
	HealthyWriteUtilizationLimitPct  int64
	DegradedWriteUtilizationLimitPct int64
	ScaleOutAtPct                    int64
	FDBLogicalSoftBytes              int64
	FDBLogicalHardBytes              int64
}

type CellCapacityPlan struct {
	Risk          string
	ScaleOutEpoch int64
	EvidenceReady bool
	Reason        string
}

type CellReport struct {
	CellName                     string
	CellUID                      string
	ObservedCellGeneration       int64
	ObservedAt                   time.Time
	ProfileDigest                string
	ClusterIdentityHash          string
	FDBAvailable                 bool
	FDBHealthy                   bool
	FDBTopologyConforming        bool
	RuntimeReadyHosts            int64
	BackupReady                  bool
	CredentialsReady             bool
	CorrectnessViolation         bool
	CapacityRisk                 string
	ScaleOutEpoch                int64
	PlacementCount               int64
	PendingReservations          int64
	ActiveWriters                int64
	InFlightCommits              int64
	MigrationBacklog             int64
	CompactionBacklog            int64
	GCBacklog                    int64
	ReconciliationBacklog        int64
	FDBStorageHeadroomBytes      int64
	FDBLogicalBytes              int64
	FDBLogicalBytesKnown         bool
	FDBStorageHeadroomETASeconds int64
	FDBStorageHeadroomETAKnown   bool
	FDBStorageHeadroomSamples    int64
	FDBWriteUtilizationPercent   int64
	FDBDataMovementBytes         int64
	FDBCapacityEvidenceReady     bool
	ScaleInEvidenceReady         bool
	PlacementUtilizationPercent  int64
	RuntimeUtilizationPercent    int64
	QualificationReady           bool
	QualificationReceiptRef      string
	QualificationDigest          string
	ReleaseDigest                string
	QualificationReleaseDigest   string
	Retirement                   *RetirementReport
}

type RetirementReport struct {
	Generation               int64
	ExactColdReachable       bool
	ExactBackupReachable     bool
	OldGenerationRejected    bool
	RollbackRetentionExpired bool
	ArtifactsEnumerated      bool
	FullySettled             bool
	CrossCellRestoreVerified bool
	ColdManifestRef          string
	ColdManifestDigest       string
	ReceiptRef               string
	ReceiptDigest            string
}

type CellStatus struct {
	ObservedGeneration          int64                `json:"observedGeneration"`
	Phase                       string               `json:"phase"`
	ReadyForPlacement           bool                 `json:"readyForPlacement"`
	PlacementCount              int64                `json:"placementCount"`
	PendingReservations         int64                `json:"pendingReservations"`
	ActiveWriters               int64                `json:"activeWriters"`
	InFlightCommits             int64                `json:"inFlightCommits"`
	MigrationBacklog            int64                `json:"migrationBacklog"`
	CompactionBacklog           int64                `json:"compactionBacklog"`
	GCBacklog                   int64                `json:"gcBacklog"`
	ReconciliationBacklog       int64                `json:"reconciliationBacklog"`
	ScaleInEvidenceReady        bool                 `json:"scaleInEvidenceReady"`
	PlacementUtilizationPercent int64                `json:"placementUtilizationPercent"`
	RuntimeUtilizationPercent   int64                `json:"runtimeUtilizationPercent"`
	FDBWriteUtilizationPercent  int64                `json:"fdbWriteUtilizationPercent"`
	ReportObservedAt            *metav1.Time         `json:"reportObservedAt,omitempty"`
	ProfileDigest               string               `json:"profileDigest,omitempty"`
	CapacityRisk                string               `json:"capacityRisk"`
	ScaleOutEpoch               int64                `json:"scaleOutEpoch"`
	RetirementProofVerified     bool                 `json:"retirementProofVerified"`
	RetirementProofReady        bool                 `json:"retirementProofReady"`
	FDBOperatorReady            bool                 `json:"fdbOperatorReady"`
	FDBAutoscaling              FDBAutoscalingStatus `json:"foundationDBAutoscaling"`
	Conditions                  []metav1.Condition   `json:"conditions"`
}

type FDBAutoscalingPolicy struct {
	Mode                         string
	MinProcessCount              int64
	MaxProcessCount              int64
	StepProcessCount             int64
	ScaleUpHeadroomBytes         int64
	ScaleUpETASeconds            int64
	ScaleUpSustain               time.Duration
	ScaleUpCooldown              time.Duration
	ScaleUpMinimumSamples        int64
	ScaleDownHeadroomBytes       int64
	ScaleDownWriteUtilizationPct int64
	ScaleDownSustain             time.Duration
	ScaleDownCooldown            time.Duration
	ScaleDownMinimumSamples      int64
	VolumeRetentionSeconds       int64
	VolumeGCMode                 string
}

type FDBAutoscalingStatus struct {
	Mode                    string       `json:"mode"`
	Phase                   string       `json:"phase"`
	DesiredProcessCount     int64        `json:"desiredProcessCount"`
	RecommendedProcessCount int64        `json:"recommendedProcessCount"`
	ObservedProcessCount    int64        `json:"observedProcessCount"`
	ScaleUpSignalSince      *metav1.Time `json:"scaleUpSignalSince,omitempty"`
	ScaleDownSignalSince    *metav1.Time `json:"scaleDownSignalSince,omitempty"`
	LastScaleTime           *metav1.Time `json:"lastScaleTime,omitempty"`
	LastScaleDirection      string       `json:"lastScaleDirection,omitempty"`
	Reason                  string       `json:"reason"`
	VolumeRetentionSeconds  int64        `json:"volumeRetentionSeconds"`
	VolumeGCMode            string       `json:"volumeGCMode"`
}

type CellPlan struct {
	Status          CellStatus
	RemoveFinalizer bool
	RequeueAfter    time.Duration
}

type PoolCell struct {
	Name                        string
	UID                         string
	ClaimName                   string
	ClaimUID                    string
	ClassName                   string
	Region                      string
	ManagementCluster           string
	Phase                       string
	ReadyForPlacement           bool
	CapacityRisk                string
	ScaleOutEpoch               int64
	PlacementCount              int64
	PendingReservations         int64
	ReportObservedAt            time.Time
	ScaleInEvidenceReady        bool
	PlacementUtilizationPercent int64
	RuntimeUtilizationPercent   int64
	FDBWriteUtilizationPercent  int64
	ActiveWriters               int64
	InFlightCommits             int64
	MigrationBacklog            int64
	CompactionBacklog           int64
	GCBacklog                   int64
	ReconciliationBacklog       int64
	RetirementProofVerified     bool
	RetirementProofReady        bool
	RetirementRequestID         string
}

type ScaleInPolicy struct {
	Mode            string
	EnterPercent    int64
	ExitPercent     int64
	Observation     time.Duration
	MaxConcurrent   int64
	ReportFreshness time.Duration
}

type ScaleInCandidate struct {
	CellName         string      `json:"cellName"`
	CellUID          string      `json:"cellUID"`
	RequestID        string      `json:"requestId"`
	ObservedSince    metav1.Time `json:"observedSince"`
	CompositeLoadPct int64       `json:"compositeLoadPercent"`
}

type ScaleInRequest struct {
	CellName     string
	CellUID      string
	RequestID    string
	DesiredState string
}

type PoolClaim struct {
	Name       string
	UID        string
	Phase      string
	TriggerKey string
}

type ClaimRequest struct {
	RequestID     string
	Reason        string
	CellName      string
	CellUID       string
	ScaleOutEpoch int64
}

type PoolInput struct {
	UID                           string
	Generation                    int64
	MinCells                      int64
	MaxCells                      int64
	MaxConcurrentCellProvisioning int64
	ClassName                     string
	Region                        string
	ManagementClusters            []string
	Cells                         []PoolCell
	Claims                        []PoolClaim
	ExistingConditions            []metav1.Condition
	Now                           time.Time
	ReportFreshness               time.Duration
	ScaleInPolicy                 ScaleInPolicy
	ExistingScaleInCandidate      *ScaleInCandidate
}

type PoolStatus struct {
	ObservedGeneration     int64              `json:"observedGeneration"`
	TotalCells             int64              `json:"totalCells"`
	ReadyCells             int64              `json:"readyCells"`
	PendingCells           int64              `json:"pendingCells"`
	DrainingCells          int64              `json:"drainingCells"`
	PendingClaims          int64              `json:"pendingClaims"`
	FailedClaims           int64              `json:"failedClaims"`
	DesiredCells           int64              `json:"desiredCells"`
	DesiredAdditionalCells int64              `json:"desiredAdditionalCells"`
	PlacementCount         int64              `json:"placementCount"`
	PendingReservations    int64              `json:"pendingReservations"`
	AdmissionOpen          bool               `json:"admissionOpen"`
	AdmissionCandidates    []string           `json:"admissionCandidates"`
	ScaleInCandidate       *ScaleInCandidate  `json:"scaleInCandidate,omitempty"`
	Conditions             []metav1.Condition `json:"conditions"`
}

type PoolPlan struct {
	Status         PoolStatus
	ClaimRequests  []ClaimRequest
	ScaleInRequest *ScaleInRequest
}

func hasDigest(value string) bool {
	if len(value) != 71 || value[:7] != "sha256:" {
		return false
	}
	for _, c := range value[7:] {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}

func condition(existing []metav1.Condition, now time.Time, typ string, status metav1.ConditionStatus, reason, message string, generation int64) metav1.Condition {
	lastTransition := metav1.NewTime(now.UTC())
	for _, old := range existing {
		if old.Type == typ && old.Status == status {
			lastTransition = old.LastTransitionTime
			break
		}
	}
	return metav1.Condition{
		Type:               typ,
		Status:             status,
		Reason:             reason,
		Message:            message,
		ObservedGeneration: generation,
		LastTransitionTime: lastTransition,
	}
}

func sortedConditions(conditions ...metav1.Condition) []metav1.Condition {
	sort.Slice(conditions, func(i, j int) bool { return conditions[i].Type < conditions[j].Type })
	return conditions
}
