package schema

import (
	"entgo.io/ent"
	entschema "entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// ChannelMember 保存 Private Topic 等显式成员关系。
type ChannelMember struct{ ent.Schema }

func (ChannelMember) Mixin() []ent.Mixin { return entityMixin() }

func (ChannelMember) Annotations() []entschema.Annotation {
	return entityAnnotations("channel_members", "server_id")
}

func (ChannelMember) Fields() []ent.Field {
	return []ent.Field{
		idField("server_id"),
		idField("channel_id"),
		idField("member_id"),
		field.String("state"),
		field.String("im_state"),
		field.Int64("membership_version"),
		CreatedAtField(),
		UpdatedAtField(),
	}
}

func (ChannelMember) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("server_id", "channel_id", "member_id").Unique(),
		index.Fields("server_id", "member_id", "state", "channel_id"),
		index.Fields("server_id", "channel_id", "state", "member_id"),
	}
}
