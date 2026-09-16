package schema

import (
	"entgo.io/ent"
	entschema "entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// AccountServerMembership 是“我的 Server”可重建投影。
type AccountServerMembership struct{ ent.Schema }

func (AccountServerMembership) Mixin() []ent.Mixin { return entityMixin() }

func (AccountServerMembership) Annotations() []entschema.Annotation {
	return entityAnnotations("account_server_memberships", "account_id")
}

func (AccountServerMembership) Fields() []ent.Field {
	return []ent.Field{
		idField("account_id"),
		idField("server_id"),
		idField("member_id"),
		field.String("role"),
		field.String("status"),
		field.String("server_name_snapshot"),
		field.String("server_slug_snapshot"),
		field.Int64("server_revision"),
		timeField("projected_at"),
		UpdatedAtField(),
	}
}

func (AccountServerMembership) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("account_id", "server_id").Unique(),
		index.Fields("account_id", "status", "updated_at", "server_id"),
	}
}
