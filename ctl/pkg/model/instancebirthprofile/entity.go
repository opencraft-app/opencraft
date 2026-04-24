package instancebirthprofile

import "time"

const (
	TableName = "instance_birth_profiles"

	ColumnID                 = "id"
	ColumnInstanceID         = "instance_id"
	ColumnUserID             = "user_id"
	ColumnSandboxID          = "sandbox_id"
	ColumnCreatedAtUTC       = "created_at_utc"
	ColumnBornDateForChina   = "born_date_for_china"
	ColumnBornNumberForChina = "born_number_for_china"
	ColumnUpdatedAt          = "updated_at"
)

type Entity struct {
	ID                 int64     `gorm:"column:id;primaryKey;autoIncrement"`
	InstanceID         string    `gorm:"column:instance_id;uniqueIndex:uk_instance_id"`
	UserID             string    `gorm:"column:user_id;index:idx_birth_user"`
	SandboxID          string    `gorm:"column:sandbox_id"`
	CreatedAtUTC       time.Time `gorm:"column:created_at_utc"`
	BornDateForChina   string    `gorm:"column:born_date_for_china;index:idx_birth_date_number"`
	BornNumberForChina int       `gorm:"column:born_number_for_china"`
	UpdatedAt          time.Time `gorm:"column:updated_at;autoUpdateTime"`
}

func (Entity) TableName() string {
	return TableName
}
