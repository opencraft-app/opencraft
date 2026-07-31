package website

// Operation 从 ctl 获取的待执行操作
type Operation struct {
	OperationID   string `json:"operation_id"`
	SiteID        string `json:"site_id"`
	ReleaseID     string `json:"release_id"`
	UserID        string `json:"user_id"`
	OperationType string `json:"operation_type"` // create/deploy/delete
	Status        string `json:"status"`
}

// DeployResult 部署结果
type DeployResult struct {
	CloudPath  string `json:"cloud_path"`
	PublicURL  string `json:"public_url"`
	Error      string `json:"error,omitempty"`
}
