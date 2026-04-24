package operationhistory

import "time"

const (
	TableName = "operation_histories"

	ColumnID             = "id"
	ColumnOperationID    = "operation_id"
	ColumnOperationType  = "operation_type"
	ColumnInstanceID     = "instance_id"
	ColumnUserID         = "user_id"
	ColumnStatus         = "status"
	ColumnErrorMessage   = "error_message"
	ColumnCreatedAt      = "created_at"
	ColumnUpdatedAt      = "updated_at"

	OperationTypeCreate     = "CREATE"
	OperationTypeDestroy    = "DESTROY"
	OperationTypePause      = "PAUSE"
	OperationTypeResume     = "RESUME"
	OperationTypeSetTimeout = "SET_TIMEOUT"

	StatusCreated = "CREATED"
	StatusRunning = "RUNNING"
	StatusSuccess = "SUCCESS"
	StatusFailed  = "FAILED"
)

type Entity struct {
	Id            int64     `gorm:"column:id;primaryKey;autoIncrement"`
	OperationId   string    `gorm:"column:operation_id;uniqueIndex:uk_operation_id"`
	OperationType string    `gorm:"column:operation_type"`
	InstanceId    string    `gorm:"column:instance_id;index:idx_instance_user"`
	UserId        string    `gorm:"column:user_id;index:idx_instance_user;index:idx_user_id"`
	Status        string    `gorm:"column:status"`
	ErrorMessage  string    `gorm:"column:error_message"`
	CreatedAt     time.Time `gorm:"column:created_at;autoCreateTime"`
	UpdatedAt     time.Time `gorm:"column:updated_at;autoUpdateTime"`
}

func (Entity) TableName() string {
	return TableName
}
