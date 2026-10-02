use gas::prelude::*;
use serde::{Deserialize, Serialize};
use utoipa::IntoParams;

#[derive(Debug, Clone, Deserialize, Serialize, IntoParams)]
#[serde(deny_unknown_fields)]
#[into_params(parameter_in = Query)]
pub struct SqliteDownloadQuery {
	pub namespace: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SqliteDownloadPath {
	pub actor_id: Id,
}
