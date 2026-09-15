package schema

import (
	"entgo.io/ent"
	entschema "entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// AgentRuntimeCredential 保存 Agent Runtime credential 的版本化强哈希。
type AgentRuntimeCredential struct{ ent.Schema }

func (AgentRuntimeCredential) Mixin() []ent.Mixin { return entityMixin() }

func (AgentRuntimeCredential) Annotations() []entschema.Annotation {
	return entityAnnotations("agent_runtime_credentials", "server_id")
}

func (AgentRuntimeCredential) Fields() []ent.Field {
	return []ent.Field{
		idField("server_id"),
		idField("agent_id"),
		field.Int64("version"),
		secretHashField("secret_hash"),
		field.String("state"),
		optionalTimeField("last_used_at"),
		CreatedAtField(),
		optionalTimeField("revoked_at"),
	}
}

func (AgentRuntimeCredential) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("server_id", "agent_id", "version").Unique(),
		index.Fields("server_id", "secret_hash").Unique(),
		index.Fields("server_id", "agent_id", "state", "version"),
	}
}
