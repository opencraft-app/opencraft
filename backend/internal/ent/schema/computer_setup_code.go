package schema

import (
	"entgo.io/ent"
	entschema "entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// ComputerSetupCode 是不含短码明文的全局 enrollment 路由索引。
type ComputerSetupCode struct{ ent.Schema }

func (ComputerSetupCode) Mixin() []ent.Mixin { return entityMixin() }

func (ComputerSetupCode) Annotations() []entschema.Annotation {
	return entityAnnotations("computer_setup_codes", "code_hash")
}

func (ComputerSetupCode) Fields() []ent.Field {
	return []ent.Field{
		hashHexField("code_hash"),
		idField("server_id"),
		idField("computer_id"),
		field.Int64("generation").Positive(),
		timeField("expires_at"),
		CreatedAtField(),
	}
}

func (ComputerSetupCode) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("code_hash").Unique(),
		index.Fields("code_hash", "expires_at", "id"),
	}
}
