package schema

import (
	"chatserver/internal/clock"
	"chatserver/internal/id"

	"entgo.io/ent"
	"entgo.io/ent/dialect"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/mixin"
)

// IDMixin 为每个业务实体提供单列、全局唯一的 UUIDv7 逻辑主键。
type IDMixin struct {
	mixin.Schema
}

// Fields 返回 Ent 的 id 字段定义。
func (IDMixin) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").
			Immutable().
			DefaultFunc(id.MustNew).
			SchemaType(map[string]string{
				dialect.SQLite: "text",
				dialect.MySQL:  "varchar(64)",
			}),
	}
}

// CreatedAtField 返回统一 UTC 毫秒语义的创建时间字段。
func CreatedAtField() ent.Field {
	return field.Time("created_at").
		Immutable().
		Default(clock.Now).
		SchemaType(map[string]string{
			dialect.SQLite: "datetime",
			dialect.MySQL:  "datetime(3)",
		})
}

// UpdatedAtField 返回统一 UTC 毫秒语义的更新时间字段。
func UpdatedAtField() ent.Field {
	return field.Time("updated_at").
		Default(clock.Now).
		UpdateDefault(clock.Now).
		SchemaType(map[string]string{
			dialect.SQLite: "datetime",
			dialect.MySQL:  "datetime(3)",
		})
}
