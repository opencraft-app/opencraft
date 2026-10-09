package schema

import (
	"entgo.io/ent"
	entschema "entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Computer 是 Server 内由腾讯云 TAT 承载的执行资源。
type Computer struct{ ent.Schema }

func (Computer) Mixin() []ent.Mixin { return entityMixin() }

func (Computer) Annotations() []entschema.Annotation {
	return entityAnnotations("computers", "server_id")
}

func (Computer) Fields() []ent.Field {
	return []ent.Field{
		idField("server_id"),
		field.String("name"),
		field.String("tat_region"),
		optionalStringField("tat_instance_id"),
		field.String("tat_instance_kind"),
		field.String("os_type"),
		field.String("lifecycle_state"),
		field.String("tat_agent_state"),
		optionalTimeField("registration_expires_at"),
		optionalTimeField("last_observed_at"),
		optionalStringField("last_error_code"),
		generatedIDField("assignment_epoch"),
		field.Int64("assignment_revision").DefaultFunc(func() int64 {
			return 1
		}),
		optionalTimeField("host_last_seen_at"),
		optionalStringField("daemon_version"),
		optionalStringField("daemon_build_id"),
		field.Int("assignment_protocol_version").Default(1),
		field.Int("profile_capability_version").Optional().Nillable(),
		optionalTimeField("daemon_version_token_issued_at"),
		optionalStringField("last_reconcile_error_code"),
		field.Int64("enrollment_generation").Default(0),
		optionalSecretHashField("enrollment_token_hash"),
		optionalTimeField("enrollment_expires_at"),
		optionalTimeField("enrollment_claimed_at"),
		field.Int64("enrollment_credential_version").Optional().Nillable(),
		optionalBoundedStringField("enrollment_release_version", 64),
		optionalTextField("enrollment_release_set_json"),
		optionalBoundedStringField("enrollment_target", 64),
		optionalBoundedStringField("enrollment_architecture", 64),
		optionalBoundedStringField("enrollment_manifest_object", 512),
		optionalSecretHashField("enrollment_manifest_sha256"),
		optionalBoundedStringField("enrollment_signature_object", 512),
		optionalSecretHashField("enrollment_signature_sha256"),
		optionalBoundedStringField("enrollment_installer_object", 512),
		optionalSecretHashField("enrollment_installer_sha256"),
		optionalBoundedStringField("enrollment_signing_key_id", 64),
		optionalBoundedStringField("enrollment_program_object", 512),
		optionalSecretHashField("enrollment_program_sha256"),
		field.Int64("enrollment_program_size").Optional().Nillable(),
		field.Int64("revision"),
		CreatedAtField(),
		UpdatedAtField(),
	}
}

func (Computer) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("server_id", "tat_region", "tat_instance_id").Unique(),
		index.Fields("server_id", "lifecycle_state", "id"),
		index.Fields("server_id", "tat_agent_state", "last_observed_at"),
	}
}
