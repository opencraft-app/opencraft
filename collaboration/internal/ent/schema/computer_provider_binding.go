package schema

import (
	"entgo.io/ent"
	entschema "entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// ComputerProviderBinding guarantees one LightVela instance belongs to one Server.
type ComputerProviderBinding struct{ ent.Schema }

func (ComputerProviderBinding) Mixin() []ent.Mixin { return entityMixin() }

func (ComputerProviderBinding) Annotations() []entschema.Annotation {
	return entityAnnotations("computer_provider_bindings", "binding_hash")
}

func (ComputerProviderBinding) Fields() []ent.Field {
	return []ent.Field{
		hashHexField("binding_hash"),
		field.String("provider_kind"),
		boundedStringField("provider_instance_id", 128),
		idField("server_id"),
		idField("computer_id"),
		field.String("state"),
		CreatedAtField(),
		UpdatedAtField(),
	}
}

func (ComputerProviderBinding) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("binding_hash").Unique(),
		index.Fields("binding_hash", "server_id", "computer_id"),
	}
}
