package website

// Operation 从 ctl 获取的待执行操作
// JSON字段名与ctl的OperationEntity Go结构体字段名一致
type Operation struct {
	OperationID     string `json:"OperationID"`
	SiteID          string `json:"SiteID"`
	ReleaseID       string `json:"ReleaseID"`
	UserID          string `json:"UserID"`
	OperationType   string `json:"OperationType"`
	Status          string `json:"Status"`
	LeaseToken      string `json:"LeaseToken"`
	ArtifactHash    string `json:"ArtifactHash"`
	ArtifactSize    int64  `json:"ArtifactSize"`
	ActiveCloudPath string `json:"ActiveCloudPath"`
}

// DeployResult 部署结果
type DeployResult struct {
	CloudPath string `json:"cloud_path"`
	PublicURL string `json:"public_url"`
	Error     string `json:"error,omitempty"`
}
