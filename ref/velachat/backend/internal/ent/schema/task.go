package schema

import (
	"entgo.io/ent"
	entschema "entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Task 是 Server 内的协作任务事实。
type Task struct{ ent.Schema }

func (Task) Mixin() []ent.Mixin { return entityMixin() }

func (Task) Annotations() []entschema.Annotation {
	return entityAnnotations("tasks", "server_id")
}

func (Task) Fields() []ent.Field {
	return []ent.Field{
		idField("server_id"),
		field.Int64("number"),
		field.String("title"),
		optionalTextField("description"),
		field.String("status"),
		optionalIDField("owner_member_id"),
		field.Int64("assignment_revision"),
		idField("created_by_member_id"),
		idField("updated_by_member_id"),
		optionalTextField("source_message_ref_json"),
		field.Int64("revision"),
		CreatedAtField(),
		UpdatedAtField(),
	}
}

func (Task) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("server_id", "number").Unique(),
		index.Fields("server_id", "owner_member_id", "status", "id"),
		index.Fields("server_id", "status", "updated_at", "id"),
	}
}
