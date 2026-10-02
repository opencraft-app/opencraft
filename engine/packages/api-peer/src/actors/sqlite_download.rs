use std::sync::Arc;

use anyhow::{Context, Result};
use axum::{
	body::{Body, Bytes},
	http::{HeaderValue, header},
	response::Response,
};
use depot::conveyer::{
	Db,
	export::{EXPORT_PAGE_BATCH_SIZE, ExportLease},
};
use futures_util::stream;
use gas::prelude::*;
use rivet_api_builder::{
	ApiCtx, ApiError,
	extract::{Extension, Path, Query},
};
use rivet_api_types::actors::sqlite_download::*;
use rivet_util::Id;

struct ExportGuard(Option<ExportLease>);

impl Drop for ExportGuard {
	fn drop(&mut self) {
		let Some(lease) = self.0.take() else {
			return;
		};
		// Response bodies are dropped on disconnect. Release the unique history pin out of band so
		// aborted downloads cannot accumulate retention indefinitely.
		tokio::spawn(async move {
			if let Err(err) = lease.release().await {
				tracing::error!(?err, "failed to release sqlite export history pin");
			}
		});
	}
}

#[utoipa::path(
	get,
	operation_id = "actors_sqlite_download",
	path = "/actors/{actor_id}/sqlite",
	params(("actor_id" = Id, Path)),
	responses(
		(status = 200, description = "A consistent standard SQLite database image", content_type = "application/vnd.sqlite3"),
	),
)]
#[tracing::instrument(skip_all)]
pub async fn sqlite_download(
	Extension(ctx): Extension<ApiCtx>,
	Path(path): Path<SqliteDownloadPath>,
	Query(query): Query<SqliteDownloadQuery>,
) -> Response {
	match sqlite_download_inner(ctx, path, query).await {
		Ok(response) => response,
		Err(err) => axum::response::IntoResponse::into_response(ApiError::from(err)),
	}
}

pub async fn sqlite_download_inner(
	ctx: ApiCtx,
	path: SqliteDownloadPath,
	query: SqliteDownloadQuery,
) -> Result<Response> {
	let actors_res = ctx
		.op(pegboard::ops::actor::get::Input {
			actor_ids: vec![path.actor_id],
			fetch_error: false,
		})
		.await?;
	let actor = actors_res
		.actors
		.into_iter()
		.next()
		.ok_or_else(|| pegboard::errors::Actor::NotFound.build())?;
	let namespace = ctx
		.op(namespace::ops::resolve_for_name_global::Input {
			name: query.namespace,
		})
		.await?
		.ok_or_else(|| namespace::errors::Namespace::NotFound.build())?;
	if actor.namespace_id != namespace.namespace_id {
		return Err(pegboard::errors::Actor::NotFound.build());
	}

	let udb = ctx.pools().udb()?;
	let cold_tier = depot::cold_tier::cold_tier_from_config(ctx.config())
		.await
		.context("initialize Depot cold tier for sqlite export")?;
	let db = match cold_tier {
		Some(cold_tier) => Db::new_with_cold_tier(
			Arc::new((*udb).clone()),
			actor.namespace_id,
			actor.actor_id.to_string(),
			ctx.pools().node_id(),
			cold_tier,
		),
		None => Db::new(
			Arc::new((*udb).clone()),
			actor.namespace_id,
			actor.actor_id.to_string(),
			ctx.pools().node_id(),
		),
	};
	let lease = ExportLease::acquire(Arc::new(db)).await?;
	let db_size_pages = lease.db_size_pages();
	let content_length = u64::from(db_size_pages) * u64::from(depot::types::SQLITE_PAGE_SIZE);
	let state = (ExportGuard(Some(lease)), 1_u32, db_size_pages);
	let body_stream = stream::try_unfold(state, |(guard, first_pgno, total_pages)| async move {
		if first_pgno > total_pages {
			return Ok::<_, anyhow::Error>(None);
		}
		let last_pgno = first_pgno
			.saturating_add(EXPORT_PAGE_BATCH_SIZE - 1)
			.min(total_pages);
		let bytes = guard
			.0
			.as_ref()
			.context("sqlite export lease was released")?
			.read_chunk(first_pgno, last_pgno)
			.await?;

		Ok::<_, anyhow::Error>(Some((
			Bytes::from(bytes),
			(guard, last_pgno.saturating_add(1), total_pages),
		)))
	});

	let filename = format!("actor-{}.sqlite", actor.actor_id);
	let disposition = HeaderValue::from_str(&format!("attachment; filename=\"{filename}\""))?;
	let mut response = Response::new(Body::from_stream(body_stream));
	let headers = response.headers_mut();
	headers.insert(
		header::CONTENT_TYPE,
		HeaderValue::from_static("application/vnd.sqlite3"),
	);
	headers.insert(header::CONTENT_DISPOSITION, disposition);
	headers.insert(
		header::CONTENT_LENGTH,
		HeaderValue::from_str(&content_length.to_string())?,
	);
	headers.insert(
		header::CACHE_CONTROL,
		HeaderValue::from_static("private, no-store"),
	);
	Ok(response)
}
