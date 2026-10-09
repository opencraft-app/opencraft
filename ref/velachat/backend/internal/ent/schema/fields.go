package schema

import (
	"regexp"

	"chatserver/internal/clock"
	"chatserver/internal/id"

	"entgo.io/ent"
	"entgo.io/ent/dialect"
	"entgo.io/ent/dialect/entsql"
	entschema "entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
)

var (
	serverSlugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$`)
	imUserIDPattern   = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)
)

func entityMixin() []ent.Mixin {
	return []ent.Mixin{IDMixin{}}
}

func entityAnnotations(table, shardKey string) []entschema.Annotation {
	return []entschema.Annotation{
		entsql.Annotation{Table: table},
		ShardKey{Field: shardKey},
	}
}

func idField(name string) ent.Field {
	return field.String(name).
		SchemaType(map[string]string{
			dialect.SQLite: "text",
			dialect.MySQL:  "varchar(64)",
		})
}

func generatedIDField(name string) ent.Field {
	return field.String(name).
		DefaultFunc(id.MustNew).
		SchemaType(map[string]string{
			dialect.SQLite: "text",
			dialect.MySQL:  "varchar(64)",
		})
}

func immutableIDField(name string) ent.Field {
	return field.String(name).
		Immutable().
		SchemaType(map[string]string{
			dialect.SQLite: "text",
			dialect.MySQL:  "varchar(64)",
		})
}

func optionalIDField(name string) ent.Field {
	return field.String(name).
		Optional().
		Nillable().
		SchemaType(map[string]string{
			dialect.SQLite: "text",
			dialect.MySQL:  "varchar(64)",
		})
}

func hashHexField(name string) ent.Field {
	return field.String(name).
		MinLen(64).
		MaxLen(64).
		SchemaType(map[string]string{
			dialect.SQLite: "text",
			dialect.MySQL:  "char(64)",
		})
}

func secretHashField(name string) ent.Field {
	return field.Bytes(name).
		MinLen(32).
		MaxLen(32).
		SchemaType(map[string]string{
			dialect.SQLite: "blob",
			dialect.MySQL:  "binary(32)",
		})
}

func optionalSecretHashField(name string) ent.Field {
	return field.Bytes(name).
		Optional().
		Nillable().
		MinLen(32).
		MaxLen(32).
		SchemaType(map[string]string{
			dialect.SQLite: "blob",
			dialect.MySQL:  "binary(32)",
		})
}

func optionalStringField(name string) ent.Field {
	return field.String(name).Optional().Nillable()
}

func boundedStringField(name string, maxLength int) ent.Field {
	return field.String(name).MaxLen(maxLength)
}

func optionalBoundedStringField(name string, maxLength int) ent.Field {
	return field.String(name).Optional().Nillable().MaxLen(maxLength)
}

func stateField(name string) ent.Field {
	return boundedStringField(name, 32)
}

func imUserIDField(name string) ent.Field {
	return field.String(name).
		MaxLen(32).
		Match(imUserIDPattern).
		SchemaType(map[string]string{
			dialect.SQLite: "text",
			dialect.MySQL:  "varchar(32)",
		})
}

func immutableIMUserIDField(name string) ent.Field {
	return field.String(name).
		MaxLen(32).
		Match(imUserIDPattern).
		Immutable().
		SchemaType(map[string]string{
			dialect.SQLite: "text",
			dialect.MySQL:  "varchar(32)",
		})
}

func serverSlugField(name string) ent.Field {
	return field.String(name).
		MinLen(2).
		MaxLen(63).
		Match(serverSlugPattern).
		Immutable().
		SchemaType(map[string]string{
			dialect.SQLite: "text",
			dialect.MySQL:  "varchar(63)",
		})
}

func optionalTextField(name string) ent.Field {
	return field.Text(name).Optional().Nillable()
}

func timeField(name string) ent.Field {
	return field.Time(name).
		SchemaType(map[string]string{
			dialect.SQLite: "datetime",
			dialect.MySQL:  "datetime(3)",
		})
}

func optionalTimeField(name string) ent.Field {
	return field.Time(name).
		Optional().
		Nillable().
		SchemaType(map[string]string{
			dialect.SQLite: "datetime",
			dialect.MySQL:  "datetime(3)",
		})
}

func currentTimeField(name string) ent.Field {
	return field.Time(name).
		Default(clock.Now).
		SchemaType(map[string]string{
			dialect.SQLite: "datetime",
			dialect.MySQL:  "datetime(3)",
		})
}
