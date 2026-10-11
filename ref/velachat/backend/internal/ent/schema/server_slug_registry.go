package schema

import (
	"entgo.io/ent"
	entschema "entgo.io/ent/schema"
	"entgo.io/ent/schema/index"
)

// ServerSlugRegistry 保证 Server slug 的全局唯一和可路由性。
type ServerSlugRegistry struct{ ent.Schema }

func (ServerSlugRegistry) Mixin() []ent.Mixin { return entityMixin() }

func (ServerSlugRegistry) Annotations() []entschema.Annotation {
	return entityAnnotations("server_slug_registry", "slug")
}

func (ServerSlugRegistry) Fields() []ent.Field {
	return []ent.Field{
		serverSlugField("slug"),
		idField("server_id"),
		stateField("state"),
		CreatedAtField(),
		UpdatedAtField(),
	}
}

func (ServerSlugRegistry) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("slug").Unique(),
		index.Fields("slug", "server_id"),
	}
}
