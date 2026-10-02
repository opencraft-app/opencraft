package workerregistry

import "context"

// RegistryStore separates the HTTP code plane from its persistence backend.
// Production uses FDB for the small mutable deployment index and COS for
// immutable WorkerVersion objects; the filesystem implementation remains
// useful for local development and deterministic unit tests.
type RegistryStore interface {
	Check(context.Context) error
	PutWorker(context.Context, string, string, PutWorkerRequest) (Worker, bool, error)
	UploadVersion(context.Context, string, string, PutWorkerRequest) (VersionSummary, bool, error)
	CreateDeployment(context.Context, string, string, CreateDeploymentRequest) (Worker, error)
	ListVersions(context.Context, string, string, int, int) (VersionList, error)
	ListDeployments(context.Context, string, string, int, int) (DeploymentList, error)
	GetDeployment(context.Context, string, string, string) (DeploymentRecord, error)
	DeleteDeployment(context.Context, string, string, string) error
	GetWorker(context.Context, string, string) (Worker, error)
	WatchDeploymentCursor(context.Context, string, string) (string, error)
	DeleteWorker(context.Context, string, string) error
	ListWorkers(context.Context, string) ([]Worker, error)
	GetVersion(context.Context, string, string, string) (WorkerVersion, error)
	GetObject(context.Context, string, string, string, string) (DurableObjectRecord, error)
	ClaimObject(context.Context, string, string, string, string, *ObjectPlacement) (DurableObjectRecord, error)
	ActivateObject(context.Context, string, string, string, string, string) (DurableObjectRecord, error)
	DeleteObject(context.Context, string, string, string, string) (DurableObjectRecord, error)
	GetCellPlacementCount(context.Context, string, string) (int64, error)
}
