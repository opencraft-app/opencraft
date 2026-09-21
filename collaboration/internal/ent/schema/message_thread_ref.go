package schema

import (
	"entgo.io/ent"
	entschema "entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// MessageThreadRef 只保存腾讯 IM 消息的可定位引用，不保存消息正文。
//
// role=root 的记录同时是 Thread 聚合根；role=reply 的记录是回复索引。
type MessageThreadRef struct{ ent.Schema }

func (MessageThreadRef) Mixin() []ent.Mixin { return entityMixin() }

func (MessageThreadRef) Annotations() []entschema.Annotation {
	return entityAnnotations("message_thread_refs", "server_id")
}

func (MessageThreadRef) Fields() []ent.Field {
	return []ent.Field{
		idField("server_id"),
		idField("channel_id"),
		idField("thread_id"),
		field.String("role"),
		field.String("message_kind"),
		field.String("message_id"),
		optionalStringField("group_id"),
		optionalStringField("topic_id"),
		optionalStringField("sender_user_id"),
		field.Int64("message_sequence").Positive(),
		field.Int64("message_timestamp").Positive(),
		idField("created_by_member_id"),
		field.Int64("reply_count").NonNegative(),
		optionalTimeField("last_reply_at"),
		CreatedAtField(),
		UpdatedAtField(),
	}
}

func (MessageThreadRef) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("server_id", "channel_id", "message_id").Unique(),
		index.Fields(
			"server_id",
			"thread_id",
			"role",
			"message_sequence",
			"id",
		),
		index.Fields(
			"server_id",
			"channel_id",
			"role",
			"last_reply_at",
			"id",
		),
	}
}
