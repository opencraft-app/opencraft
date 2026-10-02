use anyhow::Result;
use axum::response::{IntoResponse, Response};
use rivet_api_builder::{
	ApiError,
	extract::{Extension, Path, Query},
};
use rivet_api_types::actors::sqlite_download::*;
use rivet_api_util::request_remote_datacenter_raw;
use rivet_util::Id;

use crate::ctx::ApiCtx;

#[utoipa::path(
	get,
	operation_id = "actors_sqlite_download",
	path = "/actors/{actor_id}/sqlite",
	params(("actor_id" = Id, Path), SqliteDownloadQuery),
	responses(
		(status = 200, description = "A consistent standard SQLite database image", content_type = "application/vnd.sqlite3"),
	),
	security(("bearer_auth" = [])),
)]
#[tracing::instrument(skip_all)]
pub async fn sqlite_download(
	Extension(ctx): Extension<ApiCtx>,
	Path(path): Path<SqliteDownloadPath>,
	Query(query): Query<SqliteDownloadQuery>,
) -> Response {
	match sqlite_download_inner(ctx, path, query).await {
		Ok(response) => response,
		Err(err) => ApiError::from(err).into_response(),
	}
}

async fn sqlite_download_inner(
	ctx: ApiCtx,
	path: SqliteDownloadPath,
	query: SqliteDownloadQuery,
) -> Result<Response> {
	ctx.auth().await?;
	let location = ctx
		.actor_location_resolver()
		.resolve_actor_location(path.actor_id);

	if location.current_dc_label == ctx.config().dc_label() {
		rivet_api_peer::actors::sqlite_download::sqlite_download_inner(ctx.into(), path, query)
			.await
	} else {
		request_remote_datacenter_raw(
			&ctx,
			location.current_dc_label,
			&format!("/actors/{}/sqlite", path.actor_id),
			axum::http::Method::GET,
			Some(&query),
			Option::<&()>::None,
		)
		.await
	}
}
