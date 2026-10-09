package schema

import (
	"entgo.io/ent"
	entschema "entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Account 是自然人的部署级账号。
type Account struct{ ent.Schema }

func (Account) Mixin() []ent.Mixin { return entityMixin() }

func (Account) Annotations() []entschema.Annotation {
	return entityAnnotations("accounts", "id")
}

func (Account) Fields() []ent.Field {
	return []ent.Field{
		field.String("email"),
		field.String("email_normalized"),
		field.String("display_name"),
		field.String("password_hash").Sensitive(),
		field.Int64("token_version"),
		field.String("im_user_id"),
		field.String("im_state"),
		field.Int64("revision"),
		CreatedAtField(),
		UpdatedAtField(),
	}
}

func (Account) Indexes() []ent.Index {
	return []ent.Index{index.Fields("id", "im_state")}
}
