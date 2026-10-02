use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

#[derive(Debug, Serialize, Deserialize, IntoParams)]
#[serde(deny_unknown_fields)]
#[into_params(parameter_in = Query)]
pub struct GetOrCreateQuery {
	pub namespace: String,
}

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
#[schema(as = ActorsGetOrCreateRequest)]
pub struct GetOrCreateRequest {
	// Ignored in api-peer
	pub datacenter: Option<String>,
	pub name: String,
	pub key: String,
	pub input: Option<String>,
	/// Worker service to execute. Omit `version_id` to follow its active
	/// Deployment. A matching existing actor must use the same reference mode.
	#[serde(default)]
	pub worker: Option<rivet_types::actors::WorkerVersionReference>,
	pub runner_name_selector: String,
	pub crash_policy: rivet_types::actors::CrashPolicy,
}

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
#[schema(as = ActorsGetOrCreateResponse)]
pub struct GetOrCreateResponse {
	pub actor: rivet_types::actors::Actor,
	pub created: bool,
}
