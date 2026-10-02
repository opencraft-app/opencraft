package workerregistry

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"slices"
	"strings"
	"time"
)

const Schema = "rivet-worker-registry/v5"

const CellPlacementCountSchema = "rivet-worker-cell-placement-count/v1"

const CellPlacementCountShards = 64

const ObjectSchema = "rivet-worker-object/v2"

const PercentageStrategy = "percentage"

const DefaultVersionRetention = 5

const MaxVersionRetention = 100

const MaxDeploymentMessageBytes = 1000

const InitialDeploymentCursor = "c_00000000000000000000000000000000"

const (
	VersionGCStatusRetained            = "retained"
	VersionGCStatusCandidateReportOnly = "candidate_report_only"
)

type PutWorkerRequest struct {
	MainModule         string            `json:"main_module"`
	Modules            map[string]string `json:"modules"`
	CompatibilityDate  string            `json:"compatibility_date"`
	CompatibilityFlags []string          `json:"compatibility_flags,omitempty"`
	DurableObjects     map[string]string `json:"durable_objects,omitempty"`
}

const (
	BindingTypeDurableObject = "durable_object"
	ExportTypeDurableObject  = "durable_object"
	DurableObjectSQLite      = "sqlite"
	ObjectStateActive        = "active"
	ObjectStateDeleted       = "deleted"
)

// DurableObjectRecord is the persistent lifecycle fence for one logical
// Object. Deleted records are terminal tombstones: an old fetch can never
// recreate the Actor after DELETE has completed.
type DurableObjectRecord struct {
	Schema     string           `json:"schema"`
	Namespace  string           `json:"namespace"`
	Worker     string           `json:"worker"`
	ClassName  string           `json:"class_name"`
	ObjectID   string           `json:"object_id"`
	Placement  *ObjectPlacement `json:"placement,omitempty"`
	ActorID    string           `json:"actor_id,omitempty"`
	State      string           `json:"state"`
	Generation uint64           `json:"generation"`
	CreatedAt  time.Time        `json:"created_at"`
	DeletedAt  *time.Time       `json:"deleted_at,omitempty"`
}

// ObjectPlacement is the immutable Cell decision committed before Actor
// creation. The selected Cell UID prevents a same-name replacement from
// inheriting an earlier admission decision.
type ObjectPlacement struct {
	PoolName                string    `json:"pool_name"`
	PoolUID                 string    `json:"pool_uid"`
	SnapshotResourceVersion string    `json:"snapshot_resource_version"`
	SnapshotDigest          string    `json:"snapshot_digest"`
	CellName                string    `json:"cell_name"`
	CellUID                 string    `json:"cell_uid"`
	Datacenter              string    `json:"datacenter"`
	DecidedAt               time.Time `json:"decided_at"`
}

type CellPlacementCount struct {
	Schema   string `json:"schema"`
	CellName string `json:"cell_name"`
	CellUID  string `json:"cell_uid"`
	Count    int64  `json:"count"`
	Shards   int    `json:"shards"`
}

type ClaimObjectRequest struct {
	Placement *ObjectPlacement `json:"placement,omitempty"`
}

type ActivateObjectRequest struct {
	ActorID string `json:"actor_id"`
}

// VersionBinding is immutable configuration. Binding names and class targets
// therefore participate in Version identity even when the JavaScript bytes do
// not change.
type VersionBinding struct {
	Type      string `json:"type"`
	ClassName string `json:"class_name"`
}

// VersionExport describes a live entrypoint provided by an immutable Version.
// Durable Object migrations can extend this record in a future schema without
// overloading Deployment, which only selects immutable Versions.
type VersionExport struct {
	Type    string `json:"type"`
	Storage string `json:"storage"`
}

type VersionContent struct {
	Schema             string                    `json:"schema"`
	Namespace          string                    `json:"namespace"`
	Worker             string                    `json:"worker"`
	MainModule         string                    `json:"main_module"`
	Modules            map[string]string         `json:"modules"`
	CompatibilityDate  string                    `json:"compatibility_date"`
	CompatibilityFlags []string                  `json:"compatibility_flags,omitempty"`
	Bindings           map[string]VersionBinding `json:"bindings,omitempty"`
	Exports            map[string]VersionExport  `json:"exports,omitempty"`
}

type WorkerVersion struct {
	VersionID string         `json:"version_id"`
	Digest    string         `json:"digest"`
	CreatedAt time.Time      `json:"created_at"`
	Content   VersionContent `json:"content"`
}

type VersionSummary struct {
	VersionID               string                   `json:"version_id"`
	Digest                  string                   `json:"digest"`
	CreatedAt               time.Time                `json:"created_at"`
	MainModule              string                   `json:"main_module"`
	ModuleCount             int                      `json:"module_count"`
	CompatibilityDate       string                   `json:"compatibility_date"`
	DurableObjectNamespaces []DurableObjectNamespace `json:"durable_object_namespaces,omitempty"`
}

// DurableObjectNamespace is the durable deletion inventory entry. NamespaceKey
// is stable for one Worker/class lifetime; destructive class migrations will
// allocate a new generation in a future schema.
type DurableObjectNamespace struct {
	NamespaceKey string `json:"namespace_key"`
	ClassName    string `json:"class_name"`
	Storage      string `json:"storage"`
}

type VersionRecord struct {
	VersionSummary
	Deployable       bool     `json:"deployable"`
	Active           bool     `json:"active"`
	GCStatus         string   `json:"gc_status"`
	RetentionReasons []string `json:"retention_reasons,omitempty"`
	GCBlockedReason  string   `json:"gc_blocked_reason,omitempty"`
}

type VersionList struct {
	Versions  []VersionRecord `json:"versions"`
	Page      int             `json:"page"`
	PerPage   int             `json:"per_page"`
	Retention int             `json:"retention"`
	GCMode    string          `json:"gc_mode"`
}

type DeploymentVersion struct {
	VersionID  string  `json:"version_id"`
	Percentage float64 `json:"percentage"`
}

type CreateDeploymentRequest struct {
	Strategy             string                `json:"strategy"`
	Versions             []DeploymentVersion   `json:"versions"`
	Annotations          DeploymentAnnotations `json:"annotations,omitempty"`
	ExpectedDeploymentID *string               `json:"expected_deployment_id,omitempty"`
}

type DeploymentAnnotations struct {
	Message     string `json:"workers/message,omitempty"`
	TriggeredBy string `json:"workers/triggered_by,omitempty"`
}

type Deployment struct {
	ID          string                `json:"id"`
	Schema      string                `json:"schema"`
	Namespace   string                `json:"namespace"`
	Worker      string                `json:"worker"`
	Strategy    string                `json:"strategy"`
	Versions    []DeploymentVersion   `json:"versions"`
	DeployedAt  time.Time             `json:"deployed_at"`
	Source      string                `json:"source"`
	Annotations DeploymentAnnotations `json:"annotations,omitempty"`
}

type DeploymentRecord struct {
	Deployment
	Active            bool `json:"active"`
	RollbackAvailable bool `json:"rollback_available"`
}

type DeploymentList struct {
	Deployments []DeploymentRecord `json:"deployments"`
	Page        int                `json:"page"`
	PerPage     int                `json:"per_page"`
}

type Worker struct {
	Schema           string           `json:"schema"`
	Namespace        string           `json:"namespace"`
	Name             string           `json:"name"`
	Deployment       Deployment       `json:"deployment"`
	Versions         []VersionSummary `json:"versions"`
	DeploymentCursor string           `json:"deployment_cursor"`
}

// DeploymentCursor is an opaque namespace-scoped invalidation fence. It is
// changed in the same metadata transaction that replaces or removes an active
// Deployment. Consumers must compare it for equality only; its bytes do not
// encode ordering or product identity.
type DeploymentCursor struct {
	Schema    string `json:"schema"`
	Namespace string `json:"namespace"`
	Cursor    string `json:"cursor"`
}

const DeploymentCursorSchema = "rivet-worker-deployment-cursor/v1"

func newDeploymentCursor() (string, error) {
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return "", fmt.Errorf("generate Worker deployment cursor: %w", err)
	}
	return "c_" + hex.EncodeToString(random), nil
}

func validDeploymentCursor(cursor string) bool {
	if len(cursor) != len(InitialDeploymentCursor) || !strings.HasPrefix(cursor, "c_") {
		return false
	}
	_, err := hex.DecodeString(cursor[2:])
	return err == nil
}

func decodeDeploymentCursor(encoded []byte) (string, error) {
	if len(encoded) == 0 {
		return InitialDeploymentCursor, nil
	}
	cursor := string(encoded)
	if !validDeploymentCursor(cursor) {
		return "", fmt.Errorf("invalid Worker deployment cursor")
	}
	return cursor, nil
}

type WorkerList struct {
	Workers []Worker `json:"workers"`
}

func summarizeVersion(version WorkerVersion) VersionSummary {
	return VersionSummary{
		VersionID:               version.VersionID,
		Digest:                  version.Digest,
		CreatedAt:               version.CreatedAt,
		MainModule:              version.Content.MainModule,
		ModuleCount:             len(version.Content.Modules),
		CompatibilityDate:       version.Content.CompatibilityDate,
		DurableObjectNamespaces: durableObjectNamespaces(version.Content),
	}
}

// sameVersionIdentity compares only immutable, content-derived metadata.
// CreatedAt is assigned by the first successful publisher, and an omitted
// empty namespace inventory decodes as nil, so neither distinction may turn
// an idempotent concurrent upload into an immutable conflict.
func sameVersionIdentity(left, right VersionSummary) bool {
	return left.VersionID == right.VersionID &&
		left.Digest == right.Digest &&
		left.MainModule == right.MainModule &&
		left.ModuleCount == right.ModuleCount &&
		left.CompatibilityDate == right.CompatibilityDate &&
		slices.Equal(left.DurableObjectNamespaces, right.DurableObjectNamespaces)
}
