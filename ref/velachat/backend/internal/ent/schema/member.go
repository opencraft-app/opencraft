package schema

import (
	"entgo.io/ent"
	entschema "entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Member 是 Human 或 Agent 在 Server 内的对等成员身份。
type Member struct{ ent.Schema }

func (Member) Mixin() []ent.Mixin { return entityMixin() }

func (Member) Annotations() []entschema.Annotation {
	return entityAnnotations("members", "server_id")
}

func (Member) Fields() []ent.Field {
	return []ent.Field{
		idField("server_id"),
		optionalIDField("account_id"),
		field.String("kind"),
		field.String("role"),
		field.String("display_name"),
		field.String("handle"),
		optionalStringField("active_handle_key"),
		field.String("status"),
		field.String("im_state"),
		field.Int64("revision"),
		CreatedAtField(),
		UpdatedAtField(),
	}
}

func (Member) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("server_id", "active_handle_key").Unique(),
		index.Fields("server_id", "account_id").Unique(),
		index.Fields("server_id", "status", "id"),
	}
}
