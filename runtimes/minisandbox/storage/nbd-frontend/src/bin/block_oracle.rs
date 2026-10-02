//! Deterministic raw-block workload and durable hash oracle.

use std::{
    env,
    error::Error,
    fs::{self, File, OpenOptions},
    io::Write,
    os::{
        fd::AsRawFd,
        unix::{fs::FileExt, fs::OpenOptionsExt},
    },
    path::{Path, PathBuf},
    process,
    time::{SystemTime, UNIX_EPOCH},
};

use sha2::{Digest, Sha256};

const STATE_MAGIC: &[u8; 16] = b"MSBDORACLESTATE\0";
const STATE_VERSION: u32 = 1;
const HASH_BYTES: usize = 32;
const BLOCK_SIZE: usize = 4096;
const SECTOR_SIZE: usize = 512;
const MAX_IO_BYTES: usize = 1024 * 1024;
const DEFAULT_REGION_BYTES: usize = 64 * 1024 * 1024;
const MAX_REGION_BYTES: usize = 1024 * 1024 * 1024;
const MAX_STATE_BYTES: u64 = 16 * 1024 * 1024;
const BLKGETSIZE64: libc::c_ulong = 0x8008_1272;
const BLKDISCARD: libc::c_ulong = 0x1277;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Mode {
    Run,
    Verify,
}

#[derive(Debug)]
struct Config {
    mode: Mode,
    device: PathBuf,
    state: PathBuf,
    seed: u64,
    operations: u64,
    checkpoint_every: u64,
    region_offset: u64,
    region_bytes: usize,
}

#[derive(Debug)]
struct OracleState {
    region_offset: u64,
    region_bytes: usize,
    seed: u64,
    completed_operations: u64,
    known: Vec<bool>,
    hashes: Vec<[u8; HASH_BYTES]>,
}

#[derive(Debug)]
struct OracleModel {
    state: OracleState,
    expected: Vec<u8>,
}

#[derive(Clone, Copy, Debug, Default)]
struct WorkloadStats {
    writes: u64,
    dsync_writes: u64,
    verified_reads: u64,
    skipped_reads: u64,
    trims: u64,
    flushes: u64,
    written_bytes: u64,
    read_bytes: u64,
}

#[derive(Clone, Copy, Debug)]
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(if seed == 0 {
            0x9e37_79b9_7f4a_7c15
        } else {
            seed
        })
    }

    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn fill(&mut self, bytes: &mut [u8]) {
        for chunk in bytes.chunks_mut(8) {
            let value = self.next().to_le_bytes();
            chunk.copy_from_slice(&value[..chunk.len()]);
        }
    }
}

fn main() -> Result<(), Box<dyn Error>> {
    let config = parse_args(env::args().skip(1))?;
    match config.mode {
        Mode::Run => run(&config),
        Mode::Verify => verify(&config),
    }
}

fn run(config: &Config) -> Result<(), Box<dyn Error>> {
    if config.state.exists() {
        return Err(format!(
            "refusing to overwrite oracle state: {}",
            config.state.display()
        )
        .into());
    }
    validate_geometry(config.region_offset, config.region_bytes)?;
    let device = open_device(&config.device, false)?;
    let dsync_device = OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_DSYNC)
        .open(&config.device)?;
    validate_device_size(&device, config.region_offset, config.region_bytes)?;

    let mut expected = vec![0; config.region_bytes];
    read_in_chunks(&device, config.region_offset, &mut expected)?;
    let block_count = config.region_bytes / BLOCK_SIZE;
    let mut model = OracleModel {
        state: OracleState {
            region_offset: config.region_offset,
            region_bytes: config.region_bytes,
            seed: config.seed,
            completed_operations: 0,
            known: vec![true; block_count],
            hashes: Vec::with_capacity(block_count),
        },
        expected,
    };
    for block in model.expected.chunks_exact(BLOCK_SIZE) {
        model.state.hashes.push(Sha256::digest(block).into());
    }

    let mut rng = Rng::new(config.seed);
    let mut stats = WorkloadStats::default();
    for operation in 0..config.operations {
        let choice = rng.next() % 100;
        match choice {
            0..=54 => random_write(&device, &dsync_device, &mut model, &mut rng, &mut stats)?,
            55..=84 => random_read(&device, &model, &mut rng, &mut stats)?,
            85..=94 => checkpoint(
                &device,
                &mut model,
                &config.state,
                operation + 1,
                &mut stats,
            )?,
            _ => random_trim(&device, &mut model, &mut rng, &mut stats)?,
        }
        model.state.completed_operations = operation + 1;
        if (operation + 1).is_multiple_of(config.checkpoint_every) {
            checkpoint(
                &device,
                &mut model,
                &config.state,
                operation + 1,
                &mut stats,
            )?;
        }
    }
    checkpoint(
        &device,
        &mut model,
        &config.state,
        config.operations,
        &mut stats,
    )?;
    println!(
        concat!(
            "MINISANDBOX_BLOCK_ORACLE_RUN_OK seed={} operations={} writes={} ",
            "dsync_writes={} verified_reads={} skipped_reads={} trims={} flushes={} ",
            "written_bytes={} read_bytes={} known_blocks={} state={}"
        ),
        config.seed,
        config.operations,
        stats.writes,
        stats.dsync_writes,
        stats.verified_reads,
        stats.skipped_reads,
        stats.trims,
        stats.flushes,
        stats.written_bytes,
        stats.read_bytes,
        model.state.known.iter().filter(|known| **known).count(),
        config.state.display()
    );
    Ok(())
}

fn verify(config: &Config) -> Result<(), Box<dyn Error>> {
    let state = load_state(&config.state)?;
    validate_geometry(state.region_offset, state.region_bytes)?;
    let device = open_device(&config.device, true)?;
    validate_device_size(&device, state.region_offset, state.region_bytes)?;
    let mut buffer = vec![0; MAX_IO_BYTES];
    let mut verified = 0_u64;
    let mut unknown = 0_u64;
    for (chunk_index, hashes) in state.hashes.chunks(MAX_IO_BYTES / BLOCK_SIZE).enumerate() {
        let blocks = hashes.len();
        let bytes = blocks * BLOCK_SIZE;
        let first_block = chunk_index * (MAX_IO_BYTES / BLOCK_SIZE);
        let offset = state
            .region_offset
            .checked_add(u64::try_from(first_block * BLOCK_SIZE)?)
            .ok_or("oracle verify offset overflow")?;
        device.read_exact_at(&mut buffer[..bytes], offset)?;
        for (local_block, observed) in buffer[..bytes].chunks_exact(BLOCK_SIZE).enumerate() {
            let block = first_block + local_block;
            if state.known[block] {
                let digest: [u8; HASH_BYTES] = Sha256::digest(observed).into();
                if digest != state.hashes[block] {
                    return Err(format!("oracle mismatch at logical block {block}").into());
                }
                verified += 1;
            } else {
                unknown += 1;
            }
        }
    }
    println!(
        concat!(
            "MINISANDBOX_BLOCK_ORACLE_VERIFY_OK seed={} completed_operations={} ",
            "verified_blocks={} unknown_blocks={} state={}"
        ),
        state.seed,
        state.completed_operations,
        verified,
        unknown,
        config.state.display()
    );
    Ok(())
}

fn random_write(
    device: &File,
    dsync_device: &File,
    model: &mut OracleModel,
    rng: &mut Rng,
    stats: &mut WorkloadStats,
) -> Result<(), Box<dyn Error>> {
    let length = choose_length(rng, model.state.region_bytes, true);
    let relative = choose_offset(rng, model.state.region_bytes, length, SECTOR_SIZE);
    let mut bytes = vec![0; length];
    rng.fill(&mut bytes);
    let dsync = rng.next().is_multiple_of(5);
    let target = if dsync { dsync_device } else { device };
    target.write_all_at(&bytes, model.state.region_offset + u64::try_from(relative)?)?;
    model.apply_write(relative, &bytes);
    stats.writes += 1;
    stats.dsync_writes += u64::from(dsync);
    stats.written_bytes = stats.written_bytes.saturating_add(u64::try_from(length)?);
    Ok(())
}

fn random_read(
    device: &File,
    model: &OracleModel,
    rng: &mut Rng,
    stats: &mut WorkloadStats,
) -> Result<(), Box<dyn Error>> {
    let length = choose_length(rng, model.state.region_bytes, true);
    let relative = choose_offset(rng, model.state.region_bytes, length, SECTOR_SIZE);
    let mut observed = vec![0; length];
    device.read_exact_at(
        &mut observed,
        model.state.region_offset + u64::try_from(relative)?,
    )?;
    if model.range_known(relative, length) {
        if observed != model.expected[relative..relative + length] {
            return Err(format!("oracle read mismatch at byte {relative} length {length}").into());
        }
        stats.verified_reads += 1;
        stats.read_bytes = stats.read_bytes.saturating_add(u64::try_from(length)?);
    } else {
        stats.skipped_reads += 1;
    }
    Ok(())
}

fn random_trim(
    device: &File,
    model: &mut OracleModel,
    rng: &mut Rng,
    stats: &mut WorkloadStats,
) -> Result<(), Box<dyn Error>> {
    let length = choose_length(rng, model.state.region_bytes, false);
    let relative = choose_offset(rng, model.state.region_bytes, length, BLOCK_SIZE);
    let absolute = model.state.region_offset + u64::try_from(relative)?;
    discard(device, absolute, u64::try_from(length)?)?;
    model.mark_unknown(relative, length);
    stats.trims += 1;
    Ok(())
}

fn checkpoint(
    device: &File,
    model: &mut OracleModel,
    state_path: &Path,
    completed_operations: u64,
    stats: &mut WorkloadStats,
) -> Result<(), Box<dyn Error>> {
    device.sync_all()?;
    model.state.completed_operations = completed_operations;
    persist_state(state_path, &model.state)?;
    stats.flushes += 1;
    Ok(())
}

impl OracleModel {
    fn apply_write(&mut self, offset: usize, bytes: &[u8]) {
        let end = offset + bytes.len();
        self.expected[offset..end].copy_from_slice(bytes);
        let first_block = offset / BLOCK_SIZE;
        let last_block = (end - 1) / BLOCK_SIZE;
        for block in first_block..=last_block {
            let block_start = block * BLOCK_SIZE;
            let block_end = block_start + BLOCK_SIZE;
            if self.state.known[block] || (offset <= block_start && end >= block_end) {
                self.state.known[block] = true;
                self.state.hashes[block] =
                    Sha256::digest(&self.expected[block_start..block_end]).into();
            }
        }
    }

    fn mark_unknown(&mut self, offset: usize, length: usize) {
        let first_block = offset / BLOCK_SIZE;
        let last_block = (offset + length - 1) / BLOCK_SIZE;
        for block in first_block..=last_block {
            self.state.known[block] = false;
            self.state.hashes[block] = [0; HASH_BYTES];
        }
    }

    fn range_known(&self, offset: usize, length: usize) -> bool {
        let first_block = offset / BLOCK_SIZE;
        let last_block = (offset + length - 1) / BLOCK_SIZE;
        self.state.known[first_block..=last_block]
            .iter()
            .all(|known| *known)
    }
}

fn persist_state(path: &Path, state: &OracleState) -> Result<(), Box<dyn Error>> {
    let bytes = encode_state(state)?;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let temporary = parent.join(format!(".oracle-{}-{nonce:x}.tmp", process::id()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    fs::rename(&temporary, path)?;
    File::open(parent)?.sync_all()?;
    Ok(())
}

fn encode_state(state: &OracleState) -> Result<Vec<u8>, Box<dyn Error>> {
    if state.known.len() != state.hashes.len()
        || state.known.len() != state.region_bytes / BLOCK_SIZE
    {
        return Err("oracle state shape is inconsistent".into());
    }
    let entry_bytes = state
        .known
        .len()
        .checked_mul(1 + HASH_BYTES)
        .ok_or("oracle state size overflow")?;
    let capacity = 64_usize
        .checked_add(entry_bytes)
        .and_then(|size| size.checked_add(HASH_BYTES))
        .ok_or("oracle state size overflow")?;
    let mut bytes = Vec::with_capacity(capacity);
    bytes.extend_from_slice(STATE_MAGIC);
    bytes.extend_from_slice(&STATE_VERSION.to_be_bytes());
    bytes.extend_from_slice(&u32::try_from(BLOCK_SIZE)?.to_be_bytes());
    bytes.extend_from_slice(&state.region_offset.to_be_bytes());
    bytes.extend_from_slice(&u64::try_from(state.region_bytes)?.to_be_bytes());
    bytes.extend_from_slice(&state.seed.to_be_bytes());
    bytes.extend_from_slice(&state.completed_operations.to_be_bytes());
    bytes.extend_from_slice(&u64::try_from(state.known.len())?.to_be_bytes());
    for (known, hash) in state.known.iter().zip(&state.hashes) {
        bytes.push(u8::from(*known));
        bytes.extend_from_slice(hash);
    }
    let digest = Sha256::digest(&bytes);
    bytes.extend_from_slice(&digest);
    Ok(bytes)
}

fn load_state(path: &Path) -> Result<OracleState, Box<dyn Error>> {
    if fs::metadata(path)?.len() > MAX_STATE_BYTES {
        return Err("oracle state exceeds the bounded size".into());
    }
    let bytes = fs::read(path)?;
    if bytes.len() < 64 + HASH_BYTES {
        return Err("oracle state is truncated".into());
    }
    let (body, stored_digest) = bytes.split_at(bytes.len() - HASH_BYTES);
    if Sha256::digest(body).as_slice() != stored_digest {
        return Err("oracle state digest mismatch".into());
    }
    let mut cursor = body;
    if take(&mut cursor, STATE_MAGIC.len())? != STATE_MAGIC {
        return Err("oracle state magic mismatch".into());
    }
    if take_u32(&mut cursor)? != STATE_VERSION
        || take_u32(&mut cursor)? != u32::try_from(BLOCK_SIZE)?
    {
        return Err("unsupported oracle state version or block size".into());
    }
    let region_offset = take_u64(&mut cursor)?;
    let region_bytes = usize::try_from(take_u64(&mut cursor)?)?;
    let seed = take_u64(&mut cursor)?;
    let completed_operations = take_u64(&mut cursor)?;
    let block_count = usize::try_from(take_u64(&mut cursor)?)?;
    let entry_bytes = block_count
        .checked_mul(1 + HASH_BYTES)
        .ok_or("oracle state entry count overflow")?;
    if block_count != region_bytes / BLOCK_SIZE || cursor.len() != entry_bytes {
        return Err("oracle state entry count mismatch".into());
    }
    let mut known = Vec::with_capacity(block_count);
    let mut hashes = Vec::with_capacity(block_count);
    for _ in 0..block_count {
        let flag = take(&mut cursor, 1)?[0];
        if flag > 1 {
            return Err("oracle state has an invalid known flag".into());
        }
        let mut hash = [0; HASH_BYTES];
        hash.copy_from_slice(take(&mut cursor, HASH_BYTES)?);
        known.push(flag == 1);
        hashes.push(hash);
    }
    Ok(OracleState {
        region_offset,
        region_bytes,
        seed,
        completed_operations,
        known,
        hashes,
    })
}

fn take<'a>(cursor: &mut &'a [u8], length: usize) -> Result<&'a [u8], Box<dyn Error>> {
    if cursor.len() < length {
        return Err("oracle state is truncated".into());
    }
    let (value, rest) = cursor.split_at(length);
    *cursor = rest;
    Ok(value)
}

fn take_u32(cursor: &mut &[u8]) -> Result<u32, Box<dyn Error>> {
    Ok(u32::from_be_bytes(take(cursor, 4)?.try_into()?))
}

fn take_u64(cursor: &mut &[u8]) -> Result<u64, Box<dyn Error>> {
    Ok(u64::from_be_bytes(take(cursor, 8)?.try_into()?))
}

fn read_in_chunks(file: &File, offset: u64, bytes: &mut [u8]) -> Result<(), Box<dyn Error>> {
    for (index, chunk) in bytes.chunks_mut(MAX_IO_BYTES).enumerate() {
        let chunk_offset = offset
            .checked_add(u64::try_from(index * MAX_IO_BYTES)?)
            .ok_or("oracle read offset overflow")?;
        file.read_exact_at(chunk, chunk_offset)?;
    }
    Ok(())
}

fn choose_length(rng: &mut Rng, region_bytes: usize, allow_sector: bool) -> usize {
    let lengths = if allow_sector {
        [SECTOR_SIZE, BLOCK_SIZE, 64 * 1024, MAX_IO_BYTES]
    } else {
        [BLOCK_SIZE, BLOCK_SIZE, 64 * 1024, MAX_IO_BYTES]
    };
    let start = usize::try_from(rng.next() % lengths.len() as u64).expect("choice fits");
    (0..lengths.len())
        .map(|offset| lengths[(start + offset) % lengths.len()])
        .find(|length| *length <= region_bytes)
        .expect("validated region supports one length")
}

fn choose_offset(rng: &mut Rng, region_bytes: usize, length: usize, alignment: usize) -> usize {
    let positions = (region_bytes - length) / alignment + 1;
    usize::try_from(rng.next() % positions as u64).expect("bounded position fits") * alignment
}

fn discard(file: &File, offset: u64, length: u64) -> Result<(), Box<dyn Error>> {
    let range = [offset, length];
    // SAFETY: BLKDISCARD takes a pointer to exactly two u64 values describing
    // an aligned byte range. `range` remains live for the complete ioctl.
    let result = unsafe { libc::ioctl(file.as_raw_fd(), BLKDISCARD, range.as_ptr()) };
    if result == -1 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

fn device_size(file: &File) -> Result<u64, Box<dyn Error>> {
    let mut size = 0_u64;
    // SAFETY: BLKGETSIZE64 writes one u64 to the supplied valid pointer.
    let result = unsafe { libc::ioctl(file.as_raw_fd(), BLKGETSIZE64, &mut size) };
    if result == -1 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(size)
}

fn validate_device_size(file: &File, offset: u64, length: usize) -> Result<(), Box<dyn Error>> {
    let end = offset
        .checked_add(u64::try_from(length)?)
        .ok_or("oracle region overflow")?;
    if end > device_size(file)? {
        return Err("oracle region exceeds the block device".into());
    }
    Ok(())
}

fn validate_geometry(offset: u64, length: usize) -> Result<(), Box<dyn Error>> {
    if !(BLOCK_SIZE..=MAX_REGION_BYTES).contains(&length)
        || !length.is_multiple_of(BLOCK_SIZE)
        || !offset.is_multiple_of(BLOCK_SIZE as u64)
    {
        return Err("oracle region must be 4 KiB aligned and between 4 KiB and 1 GiB".into());
    }
    Ok(())
}

fn open_device(path: &Path, read_only: bool) -> Result<File, Box<dyn Error>> {
    let file = OpenOptions::new().read(true).write(!read_only).open(path)?;
    let size = device_size(&file)?;
    if size == 0 {
        return Err("oracle device has zero size".into());
    }
    Ok(file)
}

fn parse_args(mut args: impl Iterator<Item = String>) -> Result<Config, Box<dyn Error>> {
    let mode = match args.next().as_deref() {
        Some("run") => Mode::Run,
        Some("verify") => Mode::Verify,
        Some("--help" | "-h") => {
            print_help();
            process::exit(0);
        }
        _ => return Err("first argument must be run or verify".into()),
    };
    let mut device = None;
    let mut state = None;
    let mut seed = 0x5eed_cafe_f00d_u64;
    let mut operations = 1000;
    let mut checkpoint_every = 50;
    let mut region_offset = 0;
    let mut region_bytes = DEFAULT_REGION_BYTES;
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--device" => device = Some(PathBuf::from(required(&mut args, "--device")?)),
            "--state" => state = Some(PathBuf::from(required(&mut args, "--state")?)),
            "--seed" => seed = parse_u64(&required(&mut args, "--seed")?)?,
            "--operations" => operations = required(&mut args, "--operations")?.parse()?,
            "--checkpoint-every" => {
                checkpoint_every = required(&mut args, "--checkpoint-every")?.parse()?;
            }
            "--region-offset" => region_offset = required(&mut args, "--region-offset")?.parse()?,
            "--region-bytes" => region_bytes = required(&mut args, "--region-bytes")?.parse()?,
            "--help" | "-h" => {
                print_help();
                process::exit(0);
            }
            _ => return Err(format!("unknown argument: {argument}").into()),
        }
    }
    if operations == 0 || operations > 1_000_000 || checkpoint_every == 0 {
        return Err("operations must be 1..=1000000 and checkpoint interval non-zero".into());
    }
    Ok(Config {
        mode,
        device: device.ok_or("missing --device")?,
        state: state.ok_or("missing --state")?,
        seed,
        operations,
        checkpoint_every,
        region_offset,
        region_bytes,
    })
}

fn required(
    args: &mut impl Iterator<Item = String>,
    option: &str,
) -> Result<String, Box<dyn Error>> {
    args.next()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("missing value for {option}").into())
}

fn parse_u64(value: &str) -> Result<u64, Box<dyn Error>> {
    if let Some(hex) = value.strip_prefix("0x") {
        Ok(u64::from_str_radix(hex, 16)?)
    } else {
        Ok(value.parse()?)
    }
}

fn print_help() {
    println!(concat!(
        "usage: minisandbox-block-oracle run|verify --device /dev/nbdX --state FILE ",
        "[--seed N|0xHEX] [--operations N] [--checkpoint-every N] ",
        "[--region-offset BYTES] [--region-bytes BYTES]"
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn state_round_trip_and_digest_reject_corruption() {
        let directory = TempDir::new().expect("oracle state tempdir");
        let path = directory.path().join("oracle.state");
        let state = OracleState {
            region_offset: 4096,
            region_bytes: 2 * BLOCK_SIZE,
            seed: 0x1234,
            completed_operations: 17,
            known: vec![true, false],
            hashes: vec![[0x5a; HASH_BYTES], [0; HASH_BYTES]],
        };
        fs::write(&path, encode_state(&state).expect("encode state")).expect("write state");
        let decoded = load_state(&path).expect("decode state");
        assert_eq!(decoded.region_offset, state.region_offset);
        assert_eq!(decoded.region_bytes, state.region_bytes);
        assert_eq!(decoded.seed, state.seed);
        assert_eq!(decoded.completed_operations, state.completed_operations);
        assert_eq!(decoded.known, state.known);
        assert_eq!(decoded.hashes, state.hashes);

        let mut corrupt = fs::read(&path).expect("read state");
        corrupt[20] ^= 1;
        fs::write(&path, corrupt).expect("write corrupt state");
        assert!(load_state(&path).is_err());
    }

    #[test]
    fn partial_write_cannot_make_an_unknown_block_known() {
        let mut model = OracleModel {
            state: OracleState {
                region_offset: 0,
                region_bytes: BLOCK_SIZE,
                seed: 1,
                completed_operations: 0,
                known: vec![false],
                hashes: vec![[0; HASH_BYTES]],
            },
            expected: vec![0; BLOCK_SIZE],
        };
        model.apply_write(0, &[0xa5; SECTOR_SIZE]);
        assert!(!model.state.known[0]);
        model.apply_write(0, &[0x6d; BLOCK_SIZE]);
        assert!(model.state.known[0]);
        assert_eq!(
            model.state.hashes[0],
            <[u8; HASH_BYTES]>::from(Sha256::digest([0x6d; BLOCK_SIZE]))
        );
    }
}
