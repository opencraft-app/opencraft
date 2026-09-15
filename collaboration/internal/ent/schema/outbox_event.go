package schema

import (
	"entgo.io/ent"
	entschema "entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// OutboxEvent 是与业务事实同事务提交的异步事件。
type OutboxEvent struct{ ent.Schema }

func (OutboxEvent) Mixin() []ent.Mixin { return entityMixin() }

func (OutboxEvent) Annotations() []entschema.Annotation {
	return entityAnnotations("outbox_events", "partition_key")
}

func (OutboxEvent) Fields() []ent.Field {
	return []ent.Field{
		idField("partition_key"),
		optionalIDField("server_id"),
		field.String("event_type"),
		field.String("aggregate_type"),
		idField("aggregate_id"),
		field.String("state"),
		field.Int64("attempts"),
		timeField("available_at"),
		optionalStringField("lease_owner"),
		optionalTimeField("lease_expires_at"),
		optionalStringField("last_error_code"),
		CreatedAtField(),
		optionalTimeField("processed_at"),
	}
}

func (OutboxEvent) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("partition_key", "state", "available_at", "id"),
		index.Fields("partition_key", "aggregate_type", "aggregate_id", "id"),
	}
}
