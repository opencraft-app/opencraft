//! Offline validation control plane for snapshot/fork qualification gates.

use std::{env, error::Error, fs, io::Write, path::PathBuf};

use minisandbox_block_engine::{
    BLOCK_SIZE, BlockEngine, BlockMetaRepository, BlockRepositoryConfig, CommitRangeWriteRequest,
    RangeWriteOutcome,
};
use minisandbox_nbd_frontend::EmulatorObjectStore;
use sha2::{Digest, Sha256};

#[derive(Debug)]
struct Config {
    command: String,
    database: PathBuf,
    cos_root: PathBuf,
    volume_id: Option<String>,
    snapshot_id: Option<String>,
    child_volume_id: Option<String>,
    writer_epoch: Option<u64>,
    op_id: Option<String>,
    offset: Option<u64>,
    length: Option<u64>,
    input: Option<PathBuf>,
    output: Option<PathBuf>,
    through_epoch: Option<u64>,
    through_generation: Option<u64>,
    max_rows: Option<u64>,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("minisandbox-block-admin: {error}");
        std::process::exit(1);
    }
}

#[allow(clippy::too_many_lines)]
fn run() -> Result<(), Box<dyn Error>> {
    let config = parse_args()?;
    let repository = BlockMetaRepository::open(BlockRepositoryConfig::new(&config.database))?;
    let store = EmulatorObjectStore::open(&config.cos_root)?;
    let mut engine = BlockEngine::new(repository, store);
    match config.command.as_str() {
        "snapshot" => {
            let volume_id = config
                .volume_id
                .as_deref()
                .ok_or("snapshot requires --volume-id")?;
            let snapshot_id = config
                .snapshot_id
                .as_deref()
                .ok_or("snapshot requires --snapshot-id")?;
            let snapshot = engine.snapshot(volume_id, snapshot_id)?;
            println!(
                "MINISANDBOX_BLOCK_SNAPSHOT_OK volume={} snapshot={} layer={} source_writer_epoch={}",
                volume_id, snapshot.snapshot_id, snapshot.layer_id, snapshot.source_writer_epoch
            );
        }
        "fork" => {
            let child_volume_id = config
                .child_volume_id
                .as_deref()
                .ok_or("fork requires --child-volume-id")?;
            let snapshot_id = config
                .snapshot_id
                .as_deref()
                .ok_or("fork requires --snapshot-id")?;
            let fork = engine.fork(snapshot_id, child_volume_id)?;
            println!(
                "MINISANDBOX_BLOCK_FORK_OK snapshot={} child={} inherited_layer={} writer_epoch={}",
                snapshot_id, child_volume_id, fork.inherited_layer_id, fork.volume.writer_epoch
            );
        }
        "read-range" => {
            let volume_id = config
                .volume_id
                .as_deref()
                .ok_or("read-range requires --volume-id")?;
            let offset = config.offset.ok_or("read-range requires --offset")?;
            let length = config.length.ok_or("read-range requires --length")?;
            let output = config
                .output
                .as_deref()
                .ok_or("read-range requires --output")?;
            if !offset.is_multiple_of(BLOCK_SIZE)
                || length == 0
                || !length.is_multiple_of(BLOCK_SIZE)
            {
                return Err("read range must be a non-zero aligned 4 KiB range".into());
            }
            let mut bytes = Vec::with_capacity(usize::try_from(length)?);
            for block_no in offset / BLOCK_SIZE..(offset + length) / BLOCK_SIZE {
                bytes.extend_from_slice(&engine.read(volume_id, block_no)?);
            }
            let mut file = fs::File::create(output)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            let digest = Sha256::digest(&bytes);
            println!(
                "MINISANDBOX_BLOCK_READ_OK volume={} offset={} length={} sha256={}",
                volume_id,
                offset,
                length,
                hex(&digest)
            );
        }
        "replay-range-write" => {
            let volume_id = config
                .volume_id
                .as_deref()
                .ok_or("replay-range-write requires --volume-id")?;
            let writer_epoch = config
                .writer_epoch
                .ok_or("replay-range-write requires --writer-epoch")?;
            let op_id = config
                .op_id
                .as_deref()
                .ok_or("replay-range-write requires --op-id")?;
            let offset = config
                .offset
                .ok_or("replay-range-write requires --offset")?;
            let input = config
                .input
                .as_deref()
                .ok_or("replay-range-write requires --input")?;
            let bytes = fs::read(input)?;
            let result = engine.write_range(CommitRangeWriteRequest {
                volume_id: volume_id.to_owned(),
                writer_epoch,
                op_id: op_id.to_owned(),
                offset,
                bytes,
            })?;
            let last_sequence = match result.outcome {
                RangeWriteOutcome::Applied { last_version, .. } => last_version.sequence,
                RangeWriteOutcome::StaleEpoch { current_epoch } => {
                    return Err(format!("retry was fenced by epoch {current_epoch}").into());
                }
            };
            println!(
                "MINISANDBOX_BLOCK_REPLAY_OK volume={} writer_epoch={} op_id={} replayed={} last_sequence={}",
                volume_id, writer_epoch, op_id, result.replayed, last_sequence
            );
        }
        "close-writer-retries" => {
            let volume_id = config
                .volume_id
                .as_deref()
                .ok_or("close-writer-retries requires --volume-id")?;
            let through_epoch = config
                .through_epoch
                .ok_or("close-writer-retries requires --through-epoch")?;
            let closed = engine
                .repository()
                .close_writer_retry_window(volume_id, through_epoch)?;
            println!(
                "MINISANDBOX_BLOCK_WRITER_RETRIES_CLOSED volume={volume_id} through_epoch={closed}"
            );
        }
        "close-settler-retries" => {
            let through_generation = config
                .through_generation
                .ok_or("close-settler-retries requires --through-generation")?;
            let closed = engine
                .repository()
                .close_settler_retry_window(through_generation)?;
            println!("MINISANDBOX_BLOCK_SETTLER_RETRIES_CLOSED through_generation={closed}");
        }
        "compact" => {
            let max_rows = config.max_rows.ok_or("compact requires --max-rows")?;
            let result = engine.repository().compact_retained_history(max_rows)?;
            println!(
                "MINISANDBOX_BLOCK_COMPACT_OK operation_results={} flush_barriers={} delta_heads={} versions={} pack_intents={} settlement_rounds={}",
                result.operation_results,
                result.flush_barriers,
                result.delta_heads,
                result.versions,
                result.pack_intents,
                result.settlement_rounds
            );
        }
        _ => {
            return Err(
                "command must be snapshot, fork, read-range, replay-range-write, close-writer-retries, close-settler-retries, or compact"
                    .into(),
            );
        }
    }
    Ok(())
}

fn parse_args() -> Result<Config, Box<dyn Error>> {
    let mut args = env::args().skip(1);
    let command = args.next().ok_or_else(usage)?;
    let mut database = None;
    let mut cos_root = None;
    let mut volume_id = None;
    let mut snapshot_id = None;
    let mut child_volume_id = None;
    let mut writer_epoch = None;
    let mut op_id = None;
    let mut offset = None;
    let mut length = None;
    let mut input = None;
    let mut output = None;
    let mut through_epoch = None;
    let mut through_generation = None;
    let mut max_rows = None;
    while let Some(argument) = args.next() {
        let value = args.next().ok_or_else(usage)?;
        match argument.as_str() {
            "--database" => database = Some(PathBuf::from(value)),
            "--cos-root" => cos_root = Some(PathBuf::from(value)),
            "--volume-id" => volume_id = Some(value),
            "--snapshot-id" => snapshot_id = Some(value),
            "--child-volume-id" => child_volume_id = Some(value),
            "--writer-epoch" => writer_epoch = Some(value.parse()?),
            "--op-id" => op_id = Some(value),
            "--offset" => offset = Some(value.parse()?),
            "--length" => length = Some(value.parse()?),
            "--input" => input = Some(PathBuf::from(value)),
            "--output" => output = Some(PathBuf::from(value)),
            "--through-epoch" => through_epoch = Some(value.parse()?),
            "--through-generation" => through_generation = Some(value.parse()?),
            "--max-rows" => max_rows = Some(value.parse()?),
            _ => return Err(format!("unknown argument: {argument}\n{}", usage()).into()),
        }
    }
    Ok(Config {
        command,
        database: database.ok_or_else(usage)?,
        cos_root: cos_root.ok_or_else(usage)?,
        volume_id,
        snapshot_id,
        child_volume_id,
        writer_epoch,
        op_id,
        offset,
        length,
        input,
        output,
        through_epoch,
        through_generation,
        max_rows,
    })
}

fn usage() -> String {
    "usage: minisandbox-block-admin snapshot --database PATH --cos-root PATH \
       --volume-id ID --snapshot-id ID\n       minisandbox-block-admin fork \
       --database PATH --cos-root PATH --snapshot-id ID --child-volume-id ID\n       \
       minisandbox-block-admin read-range --database PATH --cos-root PATH \
       --volume-id ID --offset N --length N --output PATH\n       \
       minisandbox-block-admin replay-range-write --database PATH --cos-root PATH \
       --volume-id ID --writer-epoch N --op-id ID --offset N --input PATH
       minisandbox-block-admin close-writer-retries --database PATH --cos-root PATH \
       --volume-id ID --through-epoch N
       minisandbox-block-admin close-settler-retries --database PATH --cos-root PATH \
       --through-generation N
       minisandbox-block-admin compact --database PATH --cos-root PATH --max-rows N"
        .to_owned()
}

fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(char::from(HEX[usize::from(byte >> 4)]));
        output.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    output
}
