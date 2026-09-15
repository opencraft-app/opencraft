package schema

import (
	"entgo.io/ent"
	entschema "entgo.io/ent/schema"
	"entgo.io/ent/schema/index"
)

// AuthSession 保存 refresh token 家族与轮换状态。
type AuthSession struct{ ent.Schema }

func (AuthSession) Mixin() []ent.Mixin { return entityMixin() }

func (AuthSession) Annotations() []entschema.Annotation {
	return entityAnnotations("auth_sessions", "account_id")
}

func (AuthSession) Fields() []ent.Field {
	return []ent.Field{
		idField("account_id"),
		idField("family_id"),
		secretHashField("refresh_token_hash"),
		timeField("expires_at"),
		optionalTimeField("used_at"),
		optionalTimeField("revoked_at"),
		CreatedAtField(),
		UpdatedAtField(),
	}
}

func (AuthSession) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("account_id", "refresh_token_hash").Unique(),
		index.Fields("account_id", "family_id"),
		index.Fields("account_id", "expires_at"),
	}
}
