use std::{
	collections::VecDeque,
	future::Future,
	pin::Pin,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
};

use anyhow::{Context, Result, anyhow, bail};
use foundationdb::{
	FdbError, KeySelector as FdbKeySelector, RangeOption as FdbRangeOption, TransactionCommitError,
	api::NetworkAutoStop,
	options::{
		ConflictRangeType as FdbConflictRangeType, MutationType as FdbMutationType,
		StreamingMode as FdbStreamingMode, TransactionOption,
	},
};
use futures_util::stream;
use tokio::sync::{mpsc, oneshot};

use crate::{
	driver::TransactionDriver,
	key_selector::KeySelector,
	options::{ConflictRangeType, MutationType, Priority, StreamingMode},
	range_option::RangeOption,
	utils::{IsolationLevel, bounded_transaction_tag},
	value::{KeyValue, Slice, Value, Values},
};

enum TransactionCommand {
	AtomicOp {
		key: Vec<u8>,
		param: Vec<u8>,
		op_type: FdbMutationType,
	},
	Get {
		key: Vec<u8>,
		snapshot: bool,
		response: oneshot::Sender<Result<Option<Slice>>>,
	},
	GetKey {
		selector: FdbKeySelector<'static>,
		snapshot: bool,
		response: oneshot::Sender<Result<Slice>>,
	},
	GetRange {
		option: FdbRangeOption<'static>,
		iteration: usize,
		snapshot: bool,
		response: oneshot::Sender<Result<Values>>,
	},
	Set {
		key: Vec<u8>,
		value: Vec<u8>,
	},
	Clear {
		key: Vec<u8>,
	},
	ClearRange {
		begin: Vec<u8>,
		end: Vec<u8>,
	},
	Commit {
		response: oneshot::Sender<Result<()>>,
	},
	Reset {
		response: Option<oneshot::Sender<Result<()>>>,
	},
	Cancel,
	OnError {
		error: FdbError,
		response: oneshot::Sender<Result<()>>,
	},
	AddConflictRange {
		begin: Vec<u8>,
		end: Vec<u8>,
		conflict_type: FdbConflictRangeType,
	},
	GetEstimatedRangeSize {
		begin: Vec<u8>,
		end: Vec<u8>,
		response: oneshot::Sender<Result<i64>>,
	},
	SetOption(TransactionOption),
}

pub struct FoundationDbTransactionDriver {
	sender: mpsc::UnboundedSender<TransactionCommand>,
	committed: AtomicBool,
	// Retaining the guard here guarantees that the FDB network outlives the transaction task.
	_network: Arc<NetworkAutoStop>,
}

impl FoundationDbTransactionDriver {
	pub fn new(
		database: Arc<foundationdb::Database>,
		network: Arc<NetworkAutoStop>,
	) -> Result<Self> {
		let transaction = database
			.create_trx()
			.context("failed to create FoundationDB transaction")?;
		let (sender, receiver) = mpsc::unbounded_channel();
		tokio::spawn(
			TransactionTask {
				state: TransactionState::Active(transaction),
				receiver,
				_network: network.clone(),
			}
			.run(),
		);

		Ok(Self {
			sender,
			committed: AtomicBool::new(false),
			_network: network,
		})
	}

	pub async fn on_error(&self, error: FdbError) -> Result<()> {
		let (response_tx, response_rx) = oneshot::channel();
		self.sender
			.send(TransactionCommand::OnError {
				error,
				response: response_tx,
			})
			.context("FoundationDB transaction task stopped before retry")?;
		let result = response_rx
			.await
			.context("FoundationDB transaction task dropped retry response")?;
		if result.is_ok() {
			self.committed.store(false, Ordering::SeqCst);
		}
		result
	}

	pub async fn reset_for_retry(&self) -> Result<()> {
		let (response_tx, response_rx) = oneshot::channel();
		self.sender
			.send(TransactionCommand::Reset {
				response: Some(response_tx),
			})
			.context("FoundationDB transaction task stopped before reset")?;
		response_rx
			.await
			.context("FoundationDB transaction task dropped reset response")??;
		self.committed.store(false, Ordering::SeqCst);
		Ok(())
	}

	fn send(&self, command: TransactionCommand) {
		let _ = self.sender.send(command);
	}

	async fn commit_inner(&self) -> Result<()> {
		if self.committed.swap(true, Ordering::SeqCst) {
			return Ok(());
		}

		let (response_tx, response_rx) = oneshot::channel();
		self.sender
			.send(TransactionCommand::Commit {
				response: response_tx,
			})
			.context("FoundationDB transaction task stopped before commit")?;
		response_rx
			.await
			.context("FoundationDB transaction task dropped commit response")?
			.inspect_err(|_| self.committed.store(false, Ordering::SeqCst))
	}
}

impl TransactionDriver for FoundationDbTransactionDriver {
	fn atomic_op(&self, key: &[u8], param: &[u8], op_type: MutationType) {
		self.send(TransactionCommand::AtomicOp {
			key: key.to_vec(),
			param: param.to_vec(),
			op_type: map_mutation_type(op_type),
		});
	}

	fn get<'a>(
		&'a self,
		key: &[u8],
		isolation_level: IsolationLevel,
	) -> Pin<Box<dyn Future<Output = Result<Option<Slice>>> + Send + 'a>> {
		let key = key.to_vec();
		Box::pin(async move {
			let (response_tx, response_rx) = oneshot::channel();
			self.sender
				.send(TransactionCommand::Get {
					key,
					snapshot: is_snapshot(isolation_level),
					response: response_tx,
				})
				.context("FoundationDB transaction task stopped before get")?;
			response_rx
				.await
				.context("FoundationDB transaction task dropped get response")?
		})
	}

	fn get_key<'a>(
		&'a self,
		selector: &KeySelector<'a>,
		isolation_level: IsolationLevel,
	) -> Pin<Box<dyn Future<Output = Result<Slice>> + Send + 'a>> {
		let selector = map_key_selector(selector);
		Box::pin(async move {
			let (response_tx, response_rx) = oneshot::channel();
			self.sender
				.send(TransactionCommand::GetKey {
					selector,
					snapshot: is_snapshot(isolation_level),
					response: response_tx,
				})
				.context("FoundationDB transaction task stopped before get_key")?;
			response_rx
				.await
				.context("FoundationDB transaction task dropped get_key response")?
		})
	}

	fn get_range<'a>(
		&'a self,
		option: &RangeOption<'a>,
		iteration: usize,
		isolation_level: IsolationLevel,
	) -> Pin<Box<dyn Future<Output = Result<Values>> + Send + 'a>> {
		let option = map_range_option(option);
		Box::pin(async move {
			let (response_tx, response_rx) = oneshot::channel();
			self.sender
				.send(TransactionCommand::GetRange {
					option,
					iteration,
					snapshot: is_snapshot(isolation_level),
					response: response_tx,
				})
				.context("FoundationDB transaction task stopped before get_range")?;
			response_rx
				.await
				.context("FoundationDB transaction task dropped get_range response")?
		})
	}

	fn get_ranges_keyvalues<'a>(
		&'a self,
		option: RangeOption<'a>,
		isolation_level: IsolationLevel,
	) -> crate::value::Stream<'a, Value> {
		let state = (Some(option), VecDeque::new(), 1usize);
		Box::pin(stream::try_unfold(
			state,
			move |(mut option, mut buffered, mut iteration)| async move {
				loop {
					if let Some(value) = buffered.pop_front() {
						return Ok(Some((value, (option, buffered, iteration))));
					}

					let Some(current) = option.take() else {
						return Ok(None);
					};
					let values = self.get_range(&current, iteration, isolation_level).await?;
					iteration += 1;
					option = current.next_range(&values);
					buffered.extend(values.into_iter().map(KeyValue::to_value));
				}
			},
		))
	}

	fn set(&self, key: &[u8], value: &[u8]) {
		self.send(TransactionCommand::Set {
			key: key.to_vec(),
			value: value.to_vec(),
		});
	}

	fn clear(&self, key: &[u8]) {
		self.send(TransactionCommand::Clear { key: key.to_vec() });
	}

	fn clear_range(&self, begin: &[u8], end: &[u8]) {
		self.send(TransactionCommand::ClearRange {
			begin: begin.to_vec(),
			end: end.to_vec(),
		});
	}

	fn commit(self: Box<Self>) -> Pin<Box<dyn Future<Output = Result<()>> + Send>> {
		Box::pin(async move { self.commit_inner().await })
	}

	fn reset(&mut self) {
		self.committed.store(false, Ordering::SeqCst);
		self.send(TransactionCommand::Reset { response: None });
	}

	fn cancel(&self) {
		self.committed.store(true, Ordering::SeqCst);
		self.send(TransactionCommand::Cancel);
	}

	fn add_conflict_range(
		&self,
		begin: &[u8],
		end: &[u8],
		conflict_type: ConflictRangeType,
	) -> Result<()> {
		if begin > end {
			bail!("FoundationDB conflict range begin is greater than end");
		}
		self.sender
			.send(TransactionCommand::AddConflictRange {
				begin: begin.to_vec(),
				end: end.to_vec(),
				conflict_type: map_conflict_range_type(conflict_type),
			})
			.context("FoundationDB transaction task stopped before add_conflict_range")
	}

	fn get_estimated_range_size_bytes<'a>(
		&'a self,
		begin: &'a [u8],
		end: &'a [u8],
	) -> Pin<Box<dyn Future<Output = Result<i64>> + Send + 'a>> {
		let begin = begin.to_vec();
		let end = end.to_vec();
		Box::pin(async move {
			let (response_tx, response_rx) = oneshot::channel();
			self.sender
				.send(TransactionCommand::GetEstimatedRangeSize {
					begin,
					end,
					response: response_tx,
				})
				.context("FoundationDB transaction task stopped before size estimate")?;
			response_rx
				.await
				.context("FoundationDB transaction task dropped size estimate response")?
		})
	}

	fn tag(&self, tag: &str) -> Result<()> {
		let tag = bounded_transaction_tag(tag);
		self.sender
			.send(TransactionCommand::SetOption(
				TransactionOption::AutoThrottleTag(tag),
			))
			.context("FoundationDB transaction task stopped before tag")
	}

	fn priority(&self, priority: Priority) -> Result<()> {
		let option = match priority {
			Priority::Low => Some(TransactionOption::PriorityBatch),
			Priority::Default => None,
			Priority::High => Some(TransactionOption::PrioritySystemImmediate),
		};
		if let Some(option) = option {
			self.sender
				.send(TransactionCommand::SetOption(option))
				.context("FoundationDB transaction task stopped before priority")?;
		}
		Ok(())
	}

	fn commit_ref(&self) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
		Box::pin(async move { self.commit_inner().await })
	}
}

enum TransactionState {
	Active(foundationdb::Transaction),
	CommitFailed(TransactionCommitError),
	Empty,
}

struct TransactionTask {
	// Field order matters: all FDB handles must be dropped before the network guard.
	state: TransactionState,
	receiver: mpsc::UnboundedReceiver<TransactionCommand>,
	_network: Arc<NetworkAutoStop>,
}

impl TransactionTask {
	fn active(&self) -> Result<&foundationdb::Transaction> {
		match &self.state {
			TransactionState::Active(transaction) => Ok(transaction),
			TransactionState::CommitFailed(_) => {
				bail!("FoundationDB transaction is waiting for on_error")
			}
			TransactionState::Empty => bail!("FoundationDB transaction is no longer available"),
		}
	}

	fn reset(&mut self) -> Result<()> {
		let state = std::mem::replace(&mut self.state, TransactionState::Empty);
		self.state = match state {
			TransactionState::Active(mut transaction) => {
				transaction.reset();
				TransactionState::Active(transaction)
			}
			TransactionState::CommitFailed(error) => TransactionState::Active(error.reset()),
			TransactionState::Empty => {
				bail!("FoundationDB transaction is no longer available")
			}
		};
		Ok(())
	}

	fn cancel(&mut self) -> Result<()> {
		let state = std::mem::replace(&mut self.state, TransactionState::Empty);
		let transaction = match state {
			TransactionState::Active(transaction) => transaction,
			TransactionState::CommitFailed(error) => error.reset(),
			TransactionState::Empty => {
				bail!("FoundationDB transaction is no longer available")
			}
		};
		self.state = TransactionState::Active(transaction.cancel().reset());
		Ok(())
	}

	async fn on_error(&mut self, error: FdbError) -> Result<()> {
		let state = std::mem::replace(&mut self.state, TransactionState::Empty);
		let result = match state {
			TransactionState::Active(transaction) => transaction.on_error(error).await,
			TransactionState::CommitFailed(error) => error.on_error().await,
			TransactionState::Empty => {
				bail!("FoundationDB transaction is no longer available")
			}
		};

		match result {
			Ok(transaction) => {
				self.state = TransactionState::Active(transaction);
				Ok(())
			}
			Err(error) => Err(anyhow::Error::new(error)),
		}
	}

	async fn run(mut self) {
		let mut deferred_error = None;

		while let Some(command) = self.receiver.recv().await {
			match command {
				TransactionCommand::AtomicOp {
					key,
					param,
					op_type,
				} => {
					if let Ok(transaction) = self.active() {
						transaction.atomic_op(&key, &param, op_type);
					}
				}
				TransactionCommand::Get {
					key,
					snapshot,
					response,
				} => {
					let result = if let Some(error) = take_deferred_error(&mut deferred_error) {
						Err(error)
					} else {
						match self.active() {
							Ok(transaction) => transaction
								.get(&key, snapshot)
								.await
								.map(|value| value.map(|value| value.to_vec().into()))
								.map_err(anyhow::Error::new),
							Err(error) => Err(error),
						}
					};
					let _ = response.send(result);
				}
				TransactionCommand::GetKey {
					selector,
					snapshot,
					response,
				} => {
					let result = if let Some(error) = take_deferred_error(&mut deferred_error) {
						Err(error)
					} else {
						match self.active() {
							Ok(transaction) => transaction
								.get_key(&selector, snapshot)
								.await
								.map(|key| key.to_vec().into())
								.map_err(anyhow::Error::new),
							Err(error) => Err(error),
						}
					};
					let _ = response.send(result);
				}
				TransactionCommand::GetRange {
					option,
					iteration,
					snapshot,
					response,
				} => {
					let result = if let Some(error) = take_deferred_error(&mut deferred_error) {
						Err(error)
					} else {
						match self.active() {
							Ok(transaction) => transaction
								.get_range(&option, iteration, snapshot)
								.await
								.map(|values| {
									let more = values.more();
									let values = values
										.iter()
										.map(|value| {
											KeyValue::new(
												value.key().to_vec(),
												value.value().to_vec(),
											)
										})
										.collect();
									Values::with_more(values, more)
								})
								.map_err(anyhow::Error::new),
							Err(error) => Err(error),
						}
					};
					let _ = response.send(result);
				}
				TransactionCommand::Set { key, value } => {
					if let Ok(transaction) = self.active() {
						transaction.set(&key, &value);
					}
				}
				TransactionCommand::Clear { key } => {
					if let Ok(transaction) = self.active() {
						transaction.clear(&key);
					}
				}
				TransactionCommand::ClearRange { begin, end } => {
					if let Ok(transaction) = self.active() {
						transaction.clear_range(&begin, &end);
					}
				}
				TransactionCommand::Commit { response } => {
					if let Some(error) = take_deferred_error(&mut deferred_error) {
						let _ = response.send(Err(error));
						continue;
					}

					let state = std::mem::replace(&mut self.state, TransactionState::Empty);
					let TransactionState::Active(transaction) = state else {
						let _ = response.send(Err(anyhow!(
							"FoundationDB transaction cannot commit in its current state"
						)));
						continue;
					};
					match transaction.commit().await {
						Ok(_) => {
							let _ = response.send(Ok(()));
							return;
						}
						Err(commit_error) => {
							let error = *commit_error;
							self.state = TransactionState::CommitFailed(commit_error);
							let _ = response.send(Err(anyhow::Error::new(error)));
						}
					}
				}
				TransactionCommand::Reset { response } => {
					let result = self.reset();
					if let Some(response) = response {
						let _ = response.send(result);
					}
				}
				TransactionCommand::Cancel => {
					let _ = self.cancel();
				}
				TransactionCommand::OnError { error, response } => {
					let result = self.on_error(error).await;
					let should_stop = result.is_err();
					let _ = response.send(result);
					if should_stop {
						return;
					}
					deferred_error = None;
				}
				TransactionCommand::AddConflictRange {
					begin,
					end,
					conflict_type,
				} => {
					if deferred_error.is_none() {
						deferred_error = self.active().ok().and_then(|transaction| {
							transaction
								.add_conflict_range(&begin, &end, conflict_type)
								.err()
						});
					}
				}
				TransactionCommand::GetEstimatedRangeSize {
					begin,
					end,
					response,
				} => {
					let result = if let Some(error) = take_deferred_error(&mut deferred_error) {
						Err(error)
					} else {
						match self.active() {
							Ok(transaction) => transaction
								.get_estimated_range_size_bytes(&begin, &end)
								.await
								.map_err(anyhow::Error::new),
							Err(error) => Err(error),
						}
					};
					let _ = response.send(result);
				}
				TransactionCommand::SetOption(option) => {
					if deferred_error.is_none() {
						deferred_error = self
							.active()
							.ok()
							.and_then(|transaction| transaction.set_option(option).err());
					}
				}
			}
		}
	}
}

fn take_deferred_error(error: &mut Option<FdbError>) -> Option<anyhow::Error> {
	error.take().map(anyhow::Error::new)
}

fn is_snapshot(isolation_level: IsolationLevel) -> bool {
	matches!(isolation_level, IsolationLevel::Snapshot)
}

fn map_key_selector(selector: &KeySelector<'_>) -> FdbKeySelector<'static> {
	FdbKeySelector::new(
		selector.key().to_vec().into(),
		selector.or_equal(),
		selector.offset(),
	)
}

fn map_range_option(option: &RangeOption<'_>) -> FdbRangeOption<'static> {
	FdbRangeOption {
		begin: map_key_selector(&option.begin),
		end: map_key_selector(&option.end),
		limit: option.limit,
		target_bytes: option.target_bytes,
		mode: map_streaming_mode(option.mode),
		reverse: option.reverse,
		__non_exhaustive: std::marker::PhantomData,
	}
}

fn map_streaming_mode(mode: StreamingMode) -> FdbStreamingMode {
	match mode {
		StreamingMode::WantAll => FdbStreamingMode::WantAll,
		StreamingMode::Iterator => FdbStreamingMode::Iterator,
		StreamingMode::Exact => FdbStreamingMode::Exact,
		StreamingMode::Small => FdbStreamingMode::Small,
		StreamingMode::Medium => FdbStreamingMode::Medium,
		StreamingMode::Large => FdbStreamingMode::Large,
		StreamingMode::Serial => FdbStreamingMode::Serial,
	}
}

fn map_mutation_type(mutation_type: MutationType) -> FdbMutationType {
	match mutation_type {
		MutationType::Add => FdbMutationType::Add,
		MutationType::And => FdbMutationType::And,
		MutationType::BitAnd => FdbMutationType::BitAnd,
		MutationType::Or => FdbMutationType::Or,
		MutationType::BitOr => FdbMutationType::BitOr,
		MutationType::Xor => FdbMutationType::Xor,
		MutationType::BitXor => FdbMutationType::BitXor,
		MutationType::AppendIfFits => FdbMutationType::AppendIfFits,
		MutationType::Max => FdbMutationType::Max,
		MutationType::Min => FdbMutationType::Min,
		MutationType::SetVersionstampedKey => FdbMutationType::SetVersionstampedKey,
		MutationType::SetVersionstampedValue => FdbMutationType::SetVersionstampedValue,
		MutationType::ByteMin => FdbMutationType::ByteMin,
		MutationType::ByteMax => FdbMutationType::ByteMax,
		MutationType::CompareAndClear => FdbMutationType::CompareAndClear,
	}
}

fn map_conflict_range_type(conflict_type: ConflictRangeType) -> FdbConflictRangeType {
	match conflict_type {
		ConflictRangeType::Read => FdbConflictRangeType::Read,
		ConflictRangeType::Write => FdbConflictRangeType::Write,
	}
}
