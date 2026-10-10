package website

import "time"

// Operation 从 ctl 获取的待执行操作
// JSON字段名与ctl的OperationEntity Go结构体字段名一致
type Operation struct {
	// nil means an older CTL omitted the fact; never treat unknown as absent.
	HasBackendHistory *bool `json:"HasBackendHistory,omitempty"`
	// Last reported total, used only as a conservative fallback for retained history.
	PreviousStorageBytes  *int64     `json:"PreviousStorageBytes,omitempty"`
	Kind                  string     `json:"Kind"`
	BackendSHA256         string     `json:"BackendSHA256"`
	OperationID           string     `json:"OperationID"`
	SiteID                string     `json:"SiteID"`
	ReleaseID             string     `json:"ReleaseID"`
	UserID                string     `json:"UserID"`
	OperationType         string     `json:"OperationType"`
	Status                string     `json:"Status"`
	LeaseToken            string     `json:"LeaseToken"`
	ArtifactHash          string     `json:"ArtifactHash"`
	ArtifactSize          int64      `json:"ArtifactSize"`
	ActiveCloudPath       string     `json:"ActiveCloudPath"`
	ActiveReleaseID       string     `json:"ActiveReleaseID"`
	ReleaseStatus         string     `json:"ReleaseStatus"`
	SiteGeneration        int64      `json:"SiteGeneration"`
	CurrentSiteGeneration int64      `json:"CurrentSiteGeneration"`
	LeaseExpiresAt        *time.Time `json:"LeaseExpiresAt"`
}

// DeployResult 部署结果
type DeployResult struct {
	CloudPath string `json:"cloud_path"`
	PublicURL string `json:"public_url"`
	Error     string `json:"error,omitempty"`
}
