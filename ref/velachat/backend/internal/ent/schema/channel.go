package schema

import (
	"entgo.io/ent"
	entschema "entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Channel 是 Server Community 内的根会话或 Topic 映射。
type Channel struct{ ent.Schema }

func (Channel) Mixin() []ent.Mixin { return entityMixin() }

func (Channel) Annotations() []entschema.Annotation {
	return entityAnnotations("channels", "server_id")
}

func (Channel) Fields() []ent.Field {
	return []ent.Field{
		idField("server_id"),
		field.String("name"),
		optionalTextField("description"),
		field.String("visibility"),
		optionalStringField("system_key"),
		field.String("im_group_id"),
		optionalStringField("im_topic_id"),
		field.String("im_state"),
		field.Int64("revision"),
		CreatedAtField(),
		UpdatedAtField(),
	}
}

func (Channel) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("server_id", "name").Unique(),
		index.Fields("server_id", "system_key").Unique(),
		index.Fields("server_id", "im_group_id", "im_topic_id").Unique(),
		index.Fields("server_id", "im_state", "id"),
	}
}
