package schema

import (
	"entgo.io/ent"
	entschema "entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// AgentIMRoute 是腾讯 IM 全局 UserID 到业务分片的稳定路由。
//
// 该表只保存资源定位，不保存聊天内容。未来 Agent 表按 server_id
// 分片后，腾讯 IM 回调仍可先按 im_user_id 定位到正确分片。
type AgentIMRoute struct{ ent.Schema }

func (AgentIMRoute) Mixin() []ent.Mixin { return entityMixin() }

func (AgentIMRoute) Annotations() []entschema.Annotation {
	return entityAnnotations("agent_im_routes", "im_user_id")
}

func (AgentIMRoute) Fields() []ent.Field {
	return []ent.Field{
		immutableIMUserIDField("im_user_id"),
		idField("server_id"),
		idField("agent_id"),
		field.String("state"),
		CreatedAtField(),
		UpdatedAtField(),
	}
}

func (AgentIMRoute) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("im_user_id").Unique(),
		index.Fields("server_id", "agent_id"),
	}
}
