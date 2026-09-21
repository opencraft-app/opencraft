package schema

import (
	"entgo.io/ent"
	entschema "entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// ReminderOccurrence 是一次具体 Reminder 到期事实。
type ReminderOccurrence struct{ ent.Schema }

func (ReminderOccurrence) Mixin() []ent.Mixin { return entityMixin() }

func (ReminderOccurrence) Annotations() []entschema.Annotation {
	return entityAnnotations("reminder_occurrences", "server_id")
}

func (ReminderOccurrence) Fields() []ent.Field {
	return []ent.Field{
		idField("server_id"),
		idField("reminder_id"),
		idField("agent_id"),
		timeField("scheduled_fire_at"),
		field.String("state"),
		optionalTimeField("acknowledged_at"),
		optionalStringField("result_code"),
		field.Text("text_snapshot"),
		CreatedAtField(),
		UpdatedAtField(),
	}
}

func (ReminderOccurrence) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("server_id", "reminder_id", "scheduled_fire_at").Unique(),
		index.Fields("server_id", "agent_id", "state", "scheduled_fire_at", "id"),
	}
}
