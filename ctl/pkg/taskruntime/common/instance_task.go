package common

type CreateInstanceTaskPayload struct {
	InstanceID     string `json:"instance_id"`
	SKUID          string `json:"sku_id,omitempty"`
	Timeout        int32  `json:"timeout"`
	SoulTemplateID string `json:"soul_template_id,omitempty"`
	OperationID    string `json:"operation_id,omitempty"`
}

type DestroyInstanceTaskPayload struct {
	InstanceID   string `json:"instance_id"`
	ReleaseQuota bool   `json:"release_quota"`
	OperationID  string `json:"operation_id,omitempty"`
}

type BuildInstanceBirthProfileTaskPayload struct {
	InstanceID string `json:"instance_id"`
}

const (
	TaskNameCreateInstance            = "CreateInstance"
	TaskNameDestroyInstance           = "DestroyInstance"
	TaskNameBuildInstanceBirthProfile = "BuildInstanceBirthProfile"
)
