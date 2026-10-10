package schema

import (
	"entgo.io/ent"
	entschema "entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Agent 保存 Agent 成员的运行配置和期望/观测状态。
type Agent struct{ ent.Schema }

func (Agent) Mixin() []ent.Mixin { return entityMixin() }

func (Agent) Annotations() []entschema.Annotation {
	return entityAnnotations("agents", "server_id")
}

func (Agent) Fields() []ent.Field {
	return []ent.Field{
		idField("server_id"),
		imUserIDField("im_user_id"),
		optionalIDField("computer_id"),
		optionalTextField("description"),
		boundedStringField("runtime_kind", 32),
		optionalBoundedStringField("runtime_model", 128),
		optionalIDField("profile_capability_refresh_id"),
		optionalTextField("profile_capabilities_json"),
		boundedStringField("reply_policy", 32),
		stateField("desired_state"),
		stateField("observed_state"),
		field.Int64("credential_version"),
		stateField("im_state"),
		field.String("im_presence").MaxLen(32).DefaultFunc(func() string {
			return "unknown"
		}),
		optionalTimeField("im_presence_updated_at"),
		field.String("im_transport_state").MaxLen(32).Default("unknown"),
		optionalTimeField("im_transport_updated_at"),
		optionalTimeField("host_last_seen_at"),
		optionalTimeField("last_observed_at"),
		optionalBoundedStringField("last_error_code", 64),
		optionalIDField("observed_assignment_epoch"),
		field.Int64("observed_generation").DefaultFunc(func() int64 {
			return 0
		}),
		field.Int64("observed_attempt").DefaultFunc(func() int64 {
			return 0
		}),
		field.Int64("observed_sequence").DefaultFunc(func() int64 {
			return 0
		}),
		optionalIDField("observed_launch_id"),
		optionalIDField("current_launch_id"),
		optionalIDField("current_launch_assignment_epoch"),
		field.Int64("current_launch_generation").Default(0),
		field.Int64("current_launch_credential_version").Default(0),
		field.Int64("current_launch_attempt").Default(0),
		optionalTimeField("current_launch_updated_at"),
		optionalTimeField("deleted_at"),
		idField("created_by_member_id"),
		field.Int64("revision"),
		CreatedAtField(),
		UpdatedAtField(),
	}
}

func (Agent) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("server_id", "im_user_id").Unique(),
		index.Fields("server_id", "computer_id", "observed_state", "id"),
		index.Fields(
			"server_id",
			"desired_state",
			"observed_state",
			"im_state",
			"last_observed_at",
			"id",
		),
	}
}
