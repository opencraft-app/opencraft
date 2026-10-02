use std::{convert::Infallible, net::TcpStream as StdTcpStream, os::fd::OwnedFd, str::FromStr};

use anyhow::{Context, Result, ensure};
use futures_util::StreamExt;
use hyper::{
	Body, Method, Request, Uri,
	client::conn,
	header::{HeaderName, HeaderValue},
};
use rivet_envoy_client::config::{HttpRequest, HttpResponse, ResponseChunk};
use tokio_stream::wrappers::UnboundedReceiverStream;

/// Forwards one Rivet HTTP request over a fresh generation-bound ingress FD.
///
/// A connection is never reused across requests or generations. Response bytes
/// remain streamed through Envoy instead of being accumulated in the host.
pub async fn forward_http(descriptor: OwnedFd, request: HttpRequest) -> Result<HttpResponse> {
	let stream = StdTcpStream::from(descriptor);
	stream
		.set_nonblocking(true)
		.context("make minisandbox ingress descriptor nonblocking")?;
	let stream =
		tokio::net::TcpStream::from_std(stream).context("adopt minisandbox ingress descriptor")?;
	let (mut sender, connection) = conn::handshake(stream)
		.await
		.context("handshake with minisandbox guest HTTP server")?;
	tokio::spawn(async move {
		if let Err(error) = connection.await {
			tracing::debug!(?error, "minisandbox guest HTTP connection closed");
		}
	});

	let method = Method::from_bytes(request.method.as_bytes())
		.context("parse minisandbox request method")?;
	let uri = Uri::from_str(&request.path).context("parse minisandbox request path")?;
	ensure!(
		uri.scheme().is_none() && uri.authority().is_none() && uri.path().starts_with('/'),
		"minisandbox request path must use HTTP origin-form"
	);
	let mut builder = Request::builder().method(method).uri(uri);
	for (name, value) in request.headers {
		let name = HeaderName::from_bytes(name.as_bytes())
			.context("parse minisandbox request header name")?;
		let value =
			HeaderValue::from_str(&value).context("parse minisandbox request header value")?;
		builder = builder.header(name, value);
	}
	ensure!(
		request.body.is_none() || request.body_stream.is_none(),
		"minisandbox request cannot contain both a body and body stream"
	);
	let body = match (request.body, request.body_stream) {
		(Some(body), None) => Body::from(body),
		(None, Some(body_stream)) => Body::wrap_stream(
			UnboundedReceiverStream::new(body_stream)
				.map(|chunk| Ok::<_, Infallible>(hyper::body::Bytes::from(chunk))),
		),
		(None, None) => Body::empty(),
		(Some(_), Some(_)) => unreachable!("request body shape was validated"),
	};
	let response = sender
		.send_request(
			builder
				.body(body)
				.context("build minisandbox guest HTTP request")?,
		)
		.await
		.context("send minisandbox guest HTTP request")?;

	let status = response.status().as_u16();
	let mut headers = std::collections::HashMap::new();
	for (name, value) in response.headers() {
		headers.insert(
			name.as_str().to_owned(),
			value
				.to_str()
				.context("guest returned a non-text HTTP header")?
				.to_owned(),
		);
	}
	let mut body = response.into_body();
	let (body_tx, body_rx) = tokio::sync::mpsc::unbounded_channel();
	tokio::spawn(async move {
		while let Some(chunk) = body.next().await {
			match chunk {
				Ok(chunk) => {
					if body_tx
						.send(ResponseChunk {
							data: chunk.to_vec(),
							finish: false,
						})
						.is_err()
					{
						return;
					}
				}
				Err(error) => {
					tracing::warn!(?error, "failed to stream minisandbox guest HTTP body");
					return;
				}
			}
		}
		let _ = body_tx.send(ResponseChunk {
			data: Vec::new(),
			finish: true,
		});
	});

	Ok(HttpResponse {
		status,
		headers,
		body: None,
		body_stream: Some(body_rx),
	})
}
