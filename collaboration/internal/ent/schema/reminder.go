package schema

import (
	"entgo.io/ent"
	entschema "entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Reminder 是 Agent 的可重复调度事实。
type Reminder struct{ ent.Schema }

func (Reminder) Mixin() []ent.Mixin { return entityMixin() }

func (Reminder) Annotations() []entschema.Annotation {
	return entityAnnotations("reminders", "server_id")
}

func (Reminder) Fields() []ent.Field {
	return []ent.Field{
		idField("server_id"),
		idField("agent_id"),
		idField("created_by_member_id"),
		field.String("schedule_kind"),
		field.String("schedule"),
		field.String("timezone"),
		field.Text("text"),
		field.String("status"),
		optionalTimeField("next_fire_at"),
		optionalStringField("anchor_kind"),
		optionalIDField("anchor_channel_id"),
		optionalIDField("anchor_thread_id"),
		optionalTextField("anchor_message_ref_json"),
		field.Int64("revision"),
		CreatedAtField(),
		UpdatedAtField(),
	}
}

func (Reminder) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("server_id", "agent_id", "status", "id"),
		index.Fields("server_id", "status", "next_fire_at", "id"),
	}
}
