package model

import (
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

const (
	UserStatusActive    = "active"
	UserStatusSuspended = "suspended"
	UserStatusDeleted   = "deleted"
)

// User 是用户在 AI Gateway 的关联记录。
// UserID 是业务系统用户标识（如 usr_XXXXXX），当前仍落在 legacy external_uid 列上。
type User struct {
	ID             uuid.UUID `gorm:"type:uuid;primaryKey" json:"id"`
	UserID         string    `gorm:"column:external_uid;type:varchar(128);uniqueIndex;not null" json:"user_id"`
	PhoneEncrypted string    `gorm:"column:phone_encrypted;type:text" json:"-"`
	PhoneHash      string    `gorm:"column:phone_hash;type:varchar(64)" json:"-"`
	PhoneMasked    string    `gorm:"column:phone_masked;type:varchar(20)" json:"phone"`
	Nickname       string    `gorm:"type:varchar(64)" json:"nickname,omitempty"`
	Status         string    `gorm:"type:varchar(20);default:'active';not null" json:"status"`
	CreatedAt      time.Time `gorm:"autoCreateTime" json:"created_at"`
	UpdatedAt      time.Time `gorm:"autoUpdateTime" json:"updated_at"`
}

func (u *User) BeforeCreate(tx *gorm.DB) error {
	if u.ID == uuid.Nil {
		u.ID = uuid.New()
	}
	return nil
}
