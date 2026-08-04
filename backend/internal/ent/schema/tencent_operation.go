package schema

import (
	"entgo.io/ent"
	entschema "entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// TencentOperation 是腾讯云 IM/TAT 副作用的可靠执行记录。
type TencentOperation struct{ ent.Schema }

func (TencentOperation) Mixin() []ent.Mixin { return entityMixin() }

func (TencentOperation) Annotations() []entschema.Annotation {
	return entityAnnotations("tencent_operations", "partition_key")
}

func (TencentOperation) Fields() []ent.Field {
	return []ent.Field{
		idField("partition_key"),
		optionalIDField("server_id"),
		field.String("service"),
		field.String("kind"),
		field.String("resource_type"),
		idField("resource_id"),
		field.String("idempotency_key"),
		field.Int64("desired_revision").Optional().Nillable(),
		optionalTextField("request_snapshot_json"),
		field.String("state"),
		field.Int64("attempts"),
		optionalTimeField("next_attempt_at"),
		optionalStringField("lease_owner"),
		optionalTimeField("lease_expires_at"),
		optionalTimeField("deadline_at"),
		optionalStringField("last_error_code"),
		optionalTextField("result_json"),
		CreatedAtField(),
		UpdatedAtField(),
		optionalTimeField("completed_at"),
	}
}

func (TencentOperation) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("partition_key", "service", "idempotency_key").Unique(),
		index.Fields("partition_key", "state", "next_attempt_at", "id"),
		index.Fields("partition_key", "resource_type", "resource_id", "desired_revision"),
	}
}
