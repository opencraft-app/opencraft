package workersapi

import "time"

const (
	resourceWorker     = "worker"
	resourceVersion    = "version"
	resourceDeployment = "deployment"
	resourceObject     = "object"
)

// Worker is the stable public representation of a deployed Worker.
type Worker struct {
	Object     string      `json:"object"`
	Name       string      `json:"name"`
	Deployment *Deployment `json:"deployment,omitempty"`
	Versions   []Version   `json:"versions"`
}

// Version is an immutable Worker source bundle.
type Version struct {
	Object            string    `json:"object"`
	ID                string    `json:"id"`
	Worker            string    `json:"worker"`
	Digest            string    `json:"digest"`
	CreatedAt         time.Time `json:"created_at"`
	MainModule        string    `json:"main_module"`
	ModuleCount       int       `json:"module_count"`
	CompatibilityDate string    `json:"compatibility_date"`
}

// Deployment assigns requests to one or two immutable Versions.
type Deployment struct {
	Object     string              `json:"object"`
	ID         string              `json:"id"`
	Worker     string              `json:"worker"`
	Versions   []DeploymentVersion `json:"versions"`
	DeployedAt time.Time           `json:"deployed_at"`
}

type DeploymentVersion struct {
	VersionID  string  `json:"version_id"`
	Percentage float64 `json:"percentage"`
}

// ObjectRef is a stable logical Durable Object reference. Actor IDs and Cells stay private.
type ObjectRef struct {
	Object    string `json:"object"`
	ID        string `json:"id"`
	Worker    string `json:"worker"`
	ClassName string `json:"class_name"`
}

type UploadVersionRequest struct {
	MainModule         string            `json:"main_module"`
	Modules            map[string]string `json:"modules"`
	CompatibilityDate  string            `json:"compatibility_date"`
	CompatibilityFlags []string          `json:"compatibility_flags,omitempty"`
	DurableObjects     map[string]string `json:"durable_objects,omitempty"`
}

type CreateDeploymentRequest struct {
	VersionID            string              `json:"version_id"`
	Versions             []DeploymentVersion `json:"versions,omitempty"`
	ExpectedDeploymentID *string             `json:"expected_deployment_id,omitempty"`
}

type ErrorResponse struct {
	Error APIError `json:"error"`
}

type APIError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
	RequestID string `json:"request_id"`
}
