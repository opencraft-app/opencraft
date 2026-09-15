package schema

import (
	"entgo.io/ent"
	entschema "entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// IdempotencyRecord 保存业务请求的幂等结果。
type IdempotencyRecord struct{ ent.Schema }

func (IdempotencyRecord) Mixin() []ent.Mixin { return entityMixin() }

func (IdempotencyRecord) Annotations() []entschema.Annotation {
	return entityAnnotations("idempotency_records", "partition_key")
}

func (IdempotencyRecord) Fields() []ent.Field {
	return []ent.Field{
		idField("partition_key"),
		field.String("scope_type"),
		idField("scope_id"),
		field.String("idempotency_key"),
		secretHashField("request_hash"),
		field.Int("response_status"),
		field.Text("response_body_json"),
		timeField("expires_at"),
		CreatedAtField(),
	}
}

func (IdempotencyRecord) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("partition_key", "scope_type", "scope_id", "idempotency_key").Unique(),
		index.Fields("partition_key", "expires_at", "id"),
	}
}
