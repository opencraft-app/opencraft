package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/dialect"
	entschema "entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// BotAgent 把一个 LightVela 实例上的 Bot（Hermes Profile）映射为独立腾讯 IM 身份。
//
// 它归属开通它的 LightVela 账号，不属于任何 Server；凭据只保存摘要。
type BotAgent struct{ ent.Schema }

func (BotAgent) Mixin() []ent.Mixin { return entityMixin() }

func (BotAgent) Annotations() []entschema.Annotation {
	return entityAnnotations("bot_agents", "account_id")
}

func (BotAgent) Fields() []ent.Field {
	return []ent.Field{
		immutableIDField("account_id"),
		field.String("instance_id").Immutable().MinLen(1).MaxLen(128),
		field.String("bot_id").Immutable().MinLen(1).MaxLen(128),
		boundedStringField("display_name", 64),
		immutableIMUserIDField("im_user_id"),
		stateField("state"),
		optionalBoundedStringField("last_error_code", 64),
		boundedStringField("command_policy", 32),
		field.Int64("credential_version"),
		field.Bytes("credential_digest").
			Optional().
			Nillable().
			Sensitive().
			MinLen(32).
			MaxLen(32).
			SchemaType(map[string]string{
				dialect.SQLite: "blob",
				dialect.MySQL:  "binary(32)",
			}),
		field.Int64("revision"),
		CreatedAtField(),
		UpdatedAtField(),
	}
}

func (BotAgent) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("account_id", "instance_id", "bot_id").Unique(),
		index.Fields("account_id", "state", "id"),
	}
}
