package schema

import (
	"entgo.io/ent"
	entschema "entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// ComputerAgentObservation 是 daemon 状态回执的幂等控制面账本。
type ComputerAgentObservation struct{ ent.Schema }

func (ComputerAgentObservation) Mixin() []ent.Mixin { return entityMixin() }

func (ComputerAgentObservation) Annotations() []entschema.Annotation {
	return entityAnnotations("computer_agent_observations", "server_id")
}

func (ComputerAgentObservation) Fields() []ent.Field {
	return []ent.Field{
		idField("server_id"),
		idField("computer_id"),
		idField("agent_id"),
		idField("assignment_epoch"),
		field.Int64("assignment_revision"),
		field.Int64("config_generation"),
		field.Int64("credential_version").Default(0),
		field.Int64("attempt"),
		field.Int64("sequence"),
		idField("launch_id"),
		field.String("state"),
		field.String("im_transport_state").Default("unknown"),
		optionalStringField("error_code"),
		field.Bool("accepted_at_ingest").Default(false),
		optionalStringField("rejection_reason_at_ingest"),
		secretHashField("request_hash"),
		timeField("observed_at"),
		CreatedAtField(),
	}
}

func (ComputerAgentObservation) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("server_id", "id").Unique(),
		index.Fields(
			"server_id",
			"agent_id",
			"config_generation",
			"attempt",
			"sequence",
		),
		index.Fields("server_id", "computer_id", "created_at", "id"),
	}
}
