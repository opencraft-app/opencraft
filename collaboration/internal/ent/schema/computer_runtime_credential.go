package schema

import (
	"entgo.io/ent"
	entschema "entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// ComputerRuntimeCredential 保存 Computer 长期运行凭据的版本和强随机摘要。
type ComputerRuntimeCredential struct{ ent.Schema }

func (ComputerRuntimeCredential) Mixin() []ent.Mixin { return entityMixin() }

func (ComputerRuntimeCredential) Annotations() []entschema.Annotation {
	return entityAnnotations("computer_runtime_credentials", "server_id")
}

func (ComputerRuntimeCredential) Fields() []ent.Field {
	return []ent.Field{
		idField("server_id"),
		idField("computer_id"),
		field.Int64("version"),
		secretHashField("secret_hash"),
		field.String("state"),
		timeField("expires_at"),
		optionalTimeField("grace_expires_at"),
		optionalTimeField("last_used_at"),
		optionalTimeField("revoked_at"),
		CreatedAtField(),
	}
}

func (ComputerRuntimeCredential) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("server_id", "computer_id", "version").Unique(),
		index.Fields("server_id", "secret_hash").Unique(),
		index.Fields("server_id", "computer_id", "state", "version"),
		index.Fields("server_id", "expires_at", "id"),
	}
}
