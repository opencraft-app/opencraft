use bytes::Bytes;
use http_body_util::Full;
use hyper::body::{Frame, Incoming as BodyIncoming};
use tokio::sync::mpsc;

pub type ResponseBodyError = Box<dyn std::error::Error + Send + Sync>;
pub type ResponseBodySender = mpsc::Sender<Result<Bytes, ResponseBodyError>>;

#[derive(Debug)]
pub struct ChannelBody {
	receiver: mpsc::Receiver<Result<Bytes, ResponseBodyError>>,
}

/// Response body type that can handle both streaming and buffered responses
#[derive(Debug)]
pub enum ResponseBody {
	/// Buffered response body
	Full(Full<Bytes>),
	/// Streaming response body
	Incoming(BodyIncoming),
	/// Streaming response body produced by an internal service.
	Channel(ChannelBody),
}

impl ResponseBody {
	/// Creates a bounded streaming response body and its producer.
	pub fn channel(capacity: usize) -> (ResponseBodySender, Self) {
		let (sender, receiver) = mpsc::channel(capacity);
		(sender, Self::Channel(ChannelBody { receiver }))
	}
}

impl http_body::Body for ResponseBody {
	type Data = Bytes;
	type Error = Box<dyn std::error::Error + Send + Sync>;

	fn poll_frame(
		self: std::pin::Pin<&mut Self>,
		cx: &mut std::task::Context<'_>,
	) -> std::task::Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
		match self.get_mut() {
			ResponseBody::Full(body) => {
				let pin = std::pin::Pin::new(body);
				match pin.poll_frame(cx) {
					std::task::Poll::Ready(Some(Ok(frame))) => {
						std::task::Poll::Ready(Some(Ok(frame)))
					}
					std::task::Poll::Ready(Some(Err(e))) => {
						std::task::Poll::Ready(Some(Err(Box::new(e))))
					}
					std::task::Poll::Ready(None) => std::task::Poll::Ready(None),
					std::task::Poll::Pending => std::task::Poll::Pending,
				}
			}
			ResponseBody::Incoming(body) => {
				let pin = std::pin::Pin::new(body);
				match pin.poll_frame(cx) {
					std::task::Poll::Ready(Some(Ok(frame))) => {
						std::task::Poll::Ready(Some(Ok(frame)))
					}
					std::task::Poll::Ready(Some(Err(e))) => {
						std::task::Poll::Ready(Some(Err(Box::new(e))))
					}
					std::task::Poll::Ready(None) => std::task::Poll::Ready(None),
					std::task::Poll::Pending => std::task::Poll::Pending,
				}
			}
			ResponseBody::Channel(body) => {
				match std::pin::Pin::new(&mut body.receiver).poll_recv(cx) {
					std::task::Poll::Ready(Some(Ok(data))) => {
						std::task::Poll::Ready(Some(Ok(Frame::data(data))))
					}
					std::task::Poll::Ready(Some(Err(error))) => {
						std::task::Poll::Ready(Some(Err(error)))
					}
					std::task::Poll::Ready(None) => std::task::Poll::Ready(None),
					std::task::Poll::Pending => std::task::Poll::Pending,
				}
			}
		}
	}

	fn is_end_stream(&self) -> bool {
		match self {
			ResponseBody::Full(body) => body.is_end_stream(),
			ResponseBody::Incoming(body) => body.is_end_stream(),
			ResponseBody::Channel(body) => body.receiver.is_closed() && body.receiver.is_empty(),
		}
	}

	fn size_hint(&self) -> http_body::SizeHint {
		match self {
			ResponseBody::Full(body) => body.size_hint(),
			ResponseBody::Incoming(body) => body.size_hint(),
			ResponseBody::Channel(_) => http_body::SizeHint::default(),
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use http_body_util::BodyExt;

	#[tokio::test]
	async fn channel_body_streams_all_chunks() {
		let (sender, body) = ResponseBody::channel(2);
		sender
			.send(Ok(Bytes::from_static(b"hello ")))
			.await
			.unwrap();
		sender.send(Ok(Bytes::from_static(b"world"))).await.unwrap();
		drop(sender);

		let collected = body.collect().await.unwrap().to_bytes();
		assert_eq!(collected, Bytes::from_static(b"hello world"));
	}
}
