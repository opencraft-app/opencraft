package eventoutbox

import (
	"fmt"
	"strings"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type Event struct {
	EventID     string
	EventType   string
	AggregateID string
	PayloadJSON []byte
	OccurredAt  time.Time
}

type Entity struct {
	EventID       string     `gorm:"column:event_id;primaryKey;size:96"`
	EventType     string     `gorm:"column:event_type;size:64;not null"`
	AggregateID   string     `gorm:"column:aggregate_id;size:96;not null"`
	PayloadJSON   []byte     `gorm:"column:payload_json;type:json;not null"`
	Status        string     `gorm:"column:status;size:16;not null"`
	AttemptCount  int        `gorm:"column:attempt_count;not null"`
	NextAttemptAt time.Time  `gorm:"column:next_attempt_at;not null"`
	LeaseToken    *string    `gorm:"column:lease_token;size:96"`
	LeaseExpires  *time.Time `gorm:"column:lease_expires_at"`
	CreatedAt     time.Time  `gorm:"column:created_at;not null"`
	PublishedAt   *time.Time `gorm:"column:published_at"`
	LastError     *string    `gorm:"column:last_error;size:1024"`
}

func (Entity) TableName() string { return "ctl_event_outbox" }

func Insert(tx *gorm.DB, event *Event) error {
	if tx == nil || event == nil {
		return fmt.Errorf("event outbox transaction and event are required")
	}
	if strings.TrimSpace(event.EventID) == "" || strings.TrimSpace(event.EventType) == "" || strings.TrimSpace(event.AggregateID) == "" || len(event.PayloadJSON) == 0 {
		return fmt.Errorf("event outbox event is incomplete")
	}
	row := Entity{
		EventID:       event.EventID,
		EventType:     event.EventType,
		AggregateID:   event.AggregateID,
		PayloadJSON:   event.PayloadJSON,
		Status:        "pending",
		NextAttemptAt: event.OccurredAt.UTC(),
		CreatedAt:     event.OccurredAt.UTC(),
	}
	return tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&row).Error
}
