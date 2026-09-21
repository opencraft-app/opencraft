package schema

import (
	"entgo.io/ent"
	entschema "entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// AccountLoginIdentity 是可全局路由的登录身份注册表。
type AccountLoginIdentity struct{ ent.Schema }

func (AccountLoginIdentity) Mixin() []ent.Mixin { return entityMixin() }

func (AccountLoginIdentity) Annotations() []entschema.Annotation {
	return entityAnnotations("account_login_identities", "login_hash")
}

func (AccountLoginIdentity) Fields() []ent.Field {
	return []ent.Field{
		hashHexField("login_hash"),
		field.String("kind"),
		field.String("normalized_login"),
		idField("account_id"),
		field.String("state"),
		CreatedAtField(),
		optionalTimeField("retired_at"),
	}
}

func (AccountLoginIdentity) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("login_hash", "kind").Unique(),
		index.Fields("login_hash", "account_id"),
	}
}
