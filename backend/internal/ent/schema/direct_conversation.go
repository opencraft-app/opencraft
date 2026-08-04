package schema

import (
	"entgo.io/ent"
	entschema "entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// DirectConversation 是 Server 内两个 Member 与腾讯 Work 群之间的 authority 映射。
// 消息正文、历史和未读继续只由腾讯云 IM 保存。
type DirectConversation struct{ ent.Schema }

func (DirectConversation) Mixin() []ent.Mixin { return entityMixin() }

func (DirectConversation) Annotations() []entschema.Annotation {
	return entityAnnotations("direct_conversations", "server_id")
}

func (DirectConversation) Fields() []ent.Field {
	return []ent.Field{
		immutableIDField("server_id"),
		immutableIDField("member_a_id"),
		immutableIDField("member_b_id"),
		field.String("im_group_id").Immutable().MinLen(1).MaxLen(255),
		stateField("status"),
		stateField("im_state"),
		field.Int64("revision"),
		CreatedAtField(),
		UpdatedAtField(),
	}
}

func (DirectConversation) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("server_id", "member_a_id", "member_b_id").Unique(),
		index.Fields("server_id", "im_group_id").Unique(),
		index.Fields("server_id", "member_a_id", "updated_at", "id"),
		index.Fields("server_id", "member_b_id", "updated_at", "id"),
		index.Fields("server_id", "im_state", "id"),
	}
}
