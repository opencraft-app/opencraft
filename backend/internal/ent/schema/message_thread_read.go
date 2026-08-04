package schema

import (
	"entgo.io/ent"
	entschema "entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// MessageThreadRead 是一个 Member 在一个 Thread 内的单调已读位置。
type MessageThreadRead struct{ ent.Schema }

func (MessageThreadRead) Mixin() []ent.Mixin { return entityMixin() }

func (MessageThreadRead) Annotations() []entschema.Annotation {
	return entityAnnotations("message_thread_reads", "server_id")
}

func (MessageThreadRead) Fields() []ent.Field {
	return []ent.Field{
		idField("server_id"),
		idField("thread_id"),
		idField("member_id"),
		idField("last_read_ref_id"),
		field.Int64("last_read_sequence").Positive(),
		timeField("last_read_at"),
		field.Int64("revision").Positive(),
		CreatedAtField(),
		UpdatedAtField(),
	}
}

func (MessageThreadRead) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("server_id", "thread_id", "member_id").Unique(),
		index.Fields("server_id", "member_id", "updated_at", "id"),
	}
}
