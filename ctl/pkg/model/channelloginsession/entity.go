package channelloginsession

import "time"

const (
	TableName = "channel_login_sessions"

	ColumnID            = "id"
	ColumnSessionID     = "session_id"
	ColumnInstanceID    = "instance_id"
	ColumnUserID        = "user_id"
	ColumnChannel       = "channel"
	ColumnStatus        = "status"
	ColumnQRCodeURL     = "qr_url"
	ColumnQRCodeASCII   = "qr_ascii"
	ColumnLastOutput    = "last_output"
	ColumnRemotePID     = "remote_pid"
	ColumnRestartStatus = "restart_status"
	ColumnRestartError  = "restart_error"
	ColumnErrorMessage  = "error_message"
	ColumnStartedAt     = "started_at"
	ColumnExpiresAt     = "expires_at"
	ColumnFinishedAt    = "finished_at"
	ColumnCreatedAt     = "created_at"
	ColumnUpdatedAt     = "updated_at"

	ChannelWeixin = "openclaw-weixin"

	StatusStarting  = "starting"
	StatusWaitingQR = "waiting_qr"
	StatusScanned   = "scanned"
	StatusSuccess   = "success"
	StatusFailed    = "failed"
	StatusTimeout   = "timeout"
	StatusCancelled = "cancelled"
	StatusExpired   = "expired"
)

var ActiveStatuses = []string{
	StatusStarting,
	StatusWaitingQR,
	StatusScanned,
}

type Entity struct {
	ID            int64      `gorm:"column:id;primaryKey;autoIncrement"`
	SessionID     string     `gorm:"column:session_id;uniqueIndex:uk_channel_login_session_id"`
	InstanceID    string     `gorm:"column:instance_id;index:idx_channel_login_instance"`
	UserID        string     `gorm:"column:user_id;index:idx_channel_login_user"`
	Channel       string     `gorm:"column:channel;index:idx_channel_login_instance"`
	Status        string     `gorm:"column:status;index:idx_channel_login_instance;index:idx_channel_login_expires"`
	QRURL         string     `gorm:"column:qr_url"`
	QRASCII       string     `gorm:"column:qr_ascii"`
	LastOutput    string     `gorm:"column:last_output"`
	RemotePID     *int64     `gorm:"column:remote_pid"`
	RestartStatus string     `gorm:"column:restart_status"`
	RestartError  string     `gorm:"column:restart_error"`
	ErrorMessage  string     `gorm:"column:error_message"`
	StartedAt     time.Time  `gorm:"column:started_at"`
	ExpiresAt     time.Time  `gorm:"column:expires_at;index:idx_channel_login_expires"`
	FinishedAt    *time.Time `gorm:"column:finished_at"`
	CreatedAt     time.Time  `gorm:"column:created_at;autoCreateTime"`
	UpdatedAt     time.Time  `gorm:"column:updated_at;autoUpdateTime"`
}

func (Entity) TableName() string {
	return TableName
}
