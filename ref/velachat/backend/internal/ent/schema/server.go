package schema

import (
	"entgo.io/ent"
	entschema "entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Server 是成员、Agent、Channel 和任务的产品空间。
type Server struct{ ent.Schema }

func (Server) Mixin() []ent.Mixin { return entityMixin() }

func (Server) Annotations() []entschema.Annotation {
	return entityAnnotations("servers", "id")
}

func (Server) Fields() []ent.Field {
	return []ent.Field{
		field.String("slug").Immutable(),
		field.String("name"),
		optionalTextField("description"),
		optionalIDField("owner_member_id"),
		field.String("im_group_id"),
		field.String("im_state"),
		field.Int64("next_task_number"),
		field.Int64("revision"),
		CreatedAtField(),
		UpdatedAtField(),
	}
}

func (Server) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("id", "im_state"),
		index.Fields("id", "owner_member_id"),
	}
}
