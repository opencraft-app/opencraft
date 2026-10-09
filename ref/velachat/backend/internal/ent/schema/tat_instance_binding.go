package schema

import (
	"entgo.io/ent"
	entschema "entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// TATInstanceBinding 保证腾讯云 TAT 实例不会被多个 Server 重复占用。
type TATInstanceBinding struct{ ent.Schema }

func (TATInstanceBinding) Mixin() []ent.Mixin { return entityMixin() }

func (TATInstanceBinding) Annotations() []entschema.Annotation {
	return entityAnnotations("tat_instance_bindings", "binding_hash")
}

func (TATInstanceBinding) Fields() []ent.Field {
	return []ent.Field{
		hashHexField("binding_hash"),
		field.String("tat_region"),
		field.String("tat_instance_id"),
		idField("server_id"),
		idField("computer_id"),
		field.String("state"),
		CreatedAtField(),
		UpdatedAtField(),
	}
}

func (TATInstanceBinding) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("binding_hash").Unique(),
		index.Fields("binding_hash", "server_id", "computer_id"),
	}
}
