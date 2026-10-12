package schema

import (
	"entgo.io/ent"
	entschema "entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
)

// IMGroup 是平台创建的腾讯普通群与 Agent 回复规则的 authority。
//
// 消息正文仍只在腾讯云 IM；本表只保存群身份、规则和生命周期。
// tencent_group_id 由 id 确定性派生，腾讯回调先反解出 id 再按分片键点查。
type IMGroup struct{ ent.Schema }

func (IMGroup) Mixin() []ent.Mixin { return entityMixin() }

func (IMGroup) Annotations() []entschema.Annotation {
	return entityAnnotations("im_groups", "id")
}

func (IMGroup) Fields() []ent.Field {
	return []ent.Field{
		field.String("tencent_group_id").Immutable().MinLen(1).MaxLen(48),
		immutableIDField("owner_account_id"),
		immutableIMUserIDField("created_by_im_user_id"),
		boundedStringField("name", 100),
		boundedStringField("reply_mode", 32),
		stateField("state"),
		field.Int64("revision"),
		CreatedAtField(),
		UpdatedAtField(),
		// 解散后才有值：owner、admin，或 tencent（在腾讯侧被解散）；管理员解散必须填写原因，展示给群成员。
		optionalBoundedStringField("dismissed_by", 16),
		optionalBoundedStringField("dismiss_reason", 200),
	}
}
