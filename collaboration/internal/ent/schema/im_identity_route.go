package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/dialect"
	entschema "entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// IMIdentityRoute 把腾讯 IM 全局 UserID 定位到 LightVela 账号或 Bot。
//
// 群成员校验、腾讯回调和封禁都先按 im_user_id 点查本表，再进入业务分片。
type IMIdentityRoute struct{ ent.Schema }

func (IMIdentityRoute) Mixin() []ent.Mixin { return entityMixin() }

func (IMIdentityRoute) Annotations() []entschema.Annotation {
	return entityAnnotations("im_identity_routes", "im_user_id")
}

func (IMIdentityRoute) Fields() []ent.Field {
	return []ent.Field{
		immutableIMUserIDField("im_user_id"),
		field.String("kind").Immutable().MaxLen(16),
		immutableIDField("account_id"),
		field.String("bot_agent_id").
			Optional().
			Nillable().
			Immutable().
			SchemaType(map[string]string{
				dialect.SQLite: "text",
				dialect.MySQL:  "varchar(64)",
			}),
		optionalTimeField("restricted_at"),
		CreatedAtField(),
		UpdatedAtField(),
	}
}

func (IMIdentityRoute) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("im_user_id").Unique(),
	}
}
