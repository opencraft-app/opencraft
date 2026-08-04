package schema

import (
	"entgo.io/ent"
	entschema "entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// ServerInvite 保存只可通过哈希验证的邀请凭证。
type ServerInvite struct{ ent.Schema }

func (ServerInvite) Mixin() []ent.Mixin { return entityMixin() }

func (ServerInvite) Annotations() []entschema.Annotation {
	return entityAnnotations("server_invites", "server_id")
}

func (ServerInvite) Fields() []ent.Field {
	return []ent.Field{
		idField("server_id"),
		secretHashField("token_hash"),
		field.String("role"),
		field.Int64("max_uses"),
		field.Int64("used_count"),
		optionalIDField("landing_channel_id"),
		timeField("expires_at"),
		optionalTimeField("revoked_at"),
		idField("created_by_member_id"),
		field.Int64("revision"),
		CreatedAtField(),
		UpdatedAtField(),
	}
}

func (ServerInvite) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("server_id", "token_hash").Unique(),
		index.Fields("server_id", "expires_at", "id"),
	}
}
