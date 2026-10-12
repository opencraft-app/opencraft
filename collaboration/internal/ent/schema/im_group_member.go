package schema

import (
	"entgo.io/ent"
	entschema "entgo.io/ent/schema"
	"entgo.io/ent/schema/index"
)

// IMGroupMember 是平台群成员关系的权威事实；腾讯回调只用于对账。
type IMGroupMember struct{ ent.Schema }

func (IMGroupMember) Mixin() []ent.Mixin { return entityMixin() }

func (IMGroupMember) Annotations() []entschema.Annotation {
	return entityAnnotations("im_group_members", "group_id")
}

func (IMGroupMember) Fields() []ent.Field {
	return []ent.Field{
		immutableIDField("group_id"),
		immutableIMUserIDField("im_user_id"),
		boundedStringField("kind", 16),
		boundedStringField("role", 16),
		stateField("state"),
		imUserIDField("added_by_im_user_id"),
		CreatedAtField(),
		UpdatedAtField(),
	}
}

func (IMGroupMember) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("group_id", "im_user_id").Unique(),
		index.Fields("group_id", "state", "id"),
	}
}
