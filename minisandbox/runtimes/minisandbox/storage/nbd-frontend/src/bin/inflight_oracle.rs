//! Possible-values oracle for a process crash during one raw block write.

use std::{
    env,
    error::Error,
    ffi::c_void,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::{fd::AsRawFd, unix::fs::OpenOptionsExt},
    path::{Path, PathBuf},
    process,
    ptr::NonNull,
    time::{SystemTime, UNIX_EPOCH},
};

use sha2::{Digest, Sha256};

const STATE_MAGIC: &[u8; 16] = b"MSBDINFLIGHTV1\0\0";
const STATE_VERSION: u32 = 1;
const HASH_BYTES: usize = 32;
const BLOCK_SIZE: usize = 4096;
const SECTOR_SIZE: usize = 512;
const MAX_REQUEST_BYTES: usize = 1024 * 1024;
const TRANSACTION_BYTES: usize = 512 * 1024;
const MAX_STATE_BYTES: u64 = 1024 * 1024;
const BLKGETSIZE64: libc::c_ulong = 0x8008_1272;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Mode {
    Prepare,
    Overwrite,
    Verify,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
enum Phase {
    Prepared = 1,
    Intent = 2,
    Completed = 3,
}

impl Phase {
    fn parse(value: u32) -> Result<Self, Box<dyn Error>> {
        match value {
            1 => Ok(Self::Prepared),
            2 => Ok(Self::Intent),
            3 => Ok(Self::Completed),
            _ => Err("in-flight state has an invalid phase".into()),
        }
    }
}

#[derive(Debug)]
struct Config {
    mode: Mode,
    device: PathBuf,
    state: PathBuf,
    go_file: Option<PathBuf>,
    request_offset: u64,
    request_bytes: usize,
    seed: u64,
}

#[derive(Debug)]
struct CrashState {
    phase: Phase,
    aligned_offset: u64,
    aligned_bytes: usize,
    request_offset: u64,
    request_bytes: usize,
    seed: u64,
    before: Vec<[u8; HASH_BYTES]>,
    after: Vec<[u8; HASH_BYTES]>,
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

#[derive(Debug)]
struct AlignedBuffer {
    pointer: NonNull<u8>,
    length: usize,
}

impl AlignedBuffer {
    fn new(length: usize) -> Result<Self, Box<dyn Error>> {
        if length == 0 || !length.is_multiple_of(SECTOR_SIZE) {
            return Err("aligned buffer length must be a non-zero sector multiple".into());
        }
        let mut pointer: *mut c_void = std::ptr::null_mut();
        // SAFETY: `pointer` is a valid out-pointer, BLOCK_SIZE is a power of
        // two and a multiple of sizeof(void *), and `length` is bounded by
        // validate_request before an I/O buffer is allocated.
        let error = unsafe { libc::posix_memalign(&raw mut pointer, BLOCK_SIZE, length) };
        if error != 0 {
            return Err(std::io::Error::from_raw_os_error(error).into());
        }
        let pointer = NonNull::new(pointer.cast::<u8>()).ok_or("posix_memalign returned null")?;
        // SAFETY: posix_memalign allocated exactly `length` writable bytes.
        unsafe { std::ptr::write_bytes(pointer.as_ptr(), 0, length) };
        Ok(Self { pointer, length })
    }

    fn as_slice(&self) -> &[u8] {
        // SAFETY: the allocation remains live for `self` and has `length`
        // initialized bytes.
        unsafe { std::slice::from_raw_parts(self.pointer.as_ptr(), self.length) }
    }

    fn as_mut_slice(&mut self) -> &mut [u8] {
        // SAFETY: `&mut self` provides exclusive access to the live allocation.
        unsafe { std::slice::from_raw_parts_mut(self.pointer.as_ptr(), self.length) }
    }
}

impl Drop for AlignedBuffer {
    fn drop(&mut self) {
        // SAFETY: `pointer` came from posix_memalign and is freed exactly once.
        unsafe { libc::free(self.pointer.as_ptr().cast::<c_void>()) };
    }
}

fn main() -> Result<(), Box<dyn Error>> {
    let config = parse_args(env::args().skip(1))?;
    match config.mode {
        Mode::Prepare => prepare(&config),
        Mode::Overwrite => overwrite(&config),
        Mode::Verify => verify(&config),
    }
}

fn prepare(config: &Config) -> Result<(), Box<dyn Error>> {
    if config.state.exists() {
        return Err(format!("refusing to overwrite state: {}", config.state.display()).into());
    }
    let (aligned_offset, aligned_bytes) =
        validate_request(config.request_offset, config.request_bytes)?;
    let device = open_direct(&config.device)?;
    validate_device_size(&device, aligned_offset, aligned_bytes)?;
    let mut baseline = AlignedBuffer::new(aligned_bytes)?;
    Rng::new(config.seed ^ 0x6261_7365_6c69_6e65).fill(baseline.as_mut_slice());
    pwrite_once(&device, aligned_offset, baseline.as_slice())?;
    device.sync_all()?;
    let before = hash_blocks(baseline.as_slice());
    let state = CrashState {
        phase: Phase::Prepared,
        aligned_offset,
        aligned_bytes,
        request_offset: config.request_offset,
        request_bytes: config.request_bytes,
        seed: config.seed,
        after: vec![[0; HASH_BYTES]; before.len()],
        before,
    };
    persist_state(&config.state, &state)?;
    println!(
        "MINISANDBOX_INFLIGHT_PREPARED offset={} bytes={} blocks={} state={}",
        state.request_offset,
        state.request_bytes,
        state.before.len(),
        config.state.display()
    );
    Ok(())
}

fn overwrite(config: &Config) -> Result<(), Box<dyn Error>> {
    let mut state = load_state(&config.state)?;
    if state.phase != Phase::Prepared {
        return Err("overwrite requires a prepared state".into());
    }
    let device = open_direct(&config.device)?;
    validate_device_size(&device, state.aligned_offset, state.aligned_bytes)?;
    let mut current = AlignedBuffer::new(state.aligned_bytes)?;
    pread_all(&device, state.aligned_offset, current.as_mut_slice())?;
    require_hashes("before overwrite", current.as_slice(), &state.before)?;

    let mut payload = AlignedBuffer::new(state.request_bytes)?;
    Rng::new(state.seed ^ 0x6f76_6572_7772_6974).fill(payload.as_mut_slice());
    let mut after_bytes = current.as_slice().to_vec();
    let relative = usize::try_from(state.request_offset - state.aligned_offset)?;
    after_bytes[relative..relative + state.request_bytes].copy_from_slice(payload.as_slice());
    state.after = hash_blocks(&after_bytes);
    state.phase = Phase::Intent;
    persist_state(&config.state, &state)?;
    println!(
        "MINISANDBOX_INFLIGHT_INTENT_READY offset={} bytes={} transactions={}",
        state.request_offset,
        state.request_bytes,
        state.aligned_bytes.div_ceil(TRANSACTION_BYTES)
    );
    std::io::stdout().flush()?;

    if let Some(go_file) = &config.go_file {
        let mut signal = [0_u8; 1];
        File::open(go_file)?.read_exact(&mut signal)?;
    }
    pwrite_once(&device, state.request_offset, payload.as_slice())?;
    state.phase = Phase::Completed;
    persist_state(&config.state, &state)?;
    println!("MINISANDBOX_INFLIGHT_WRITE_COMPLETED");
    Ok(())
}

fn verify(config: &Config) -> Result<(), Box<dyn Error>> {
    let state = load_state(&config.state)?;
    let device = open_direct(&config.device)?;
    validate_device_size(&device, state.aligned_offset, state.aligned_bytes)?;
    let mut observed = AlignedBuffer::new(state.aligned_bytes)?;
    pread_all(&device, state.aligned_offset, observed.as_mut_slice())?;
    let observed_hashes = hash_blocks(observed.as_slice());
    let cut = match state.phase {
        Phase::Prepared => {
            if observed_hashes != state.before {
                return Err("prepared state no longer matches the device".into());
            }
            0
        }
        Phase::Completed => {
            if observed_hashes != state.after {
                return Err("completed write is not fully visible".into());
            }
            state.aligned_bytes.div_ceil(TRANSACTION_BYTES)
        }
        Phase::Intent => match_possible_cut(&state, &observed_hashes)
            .ok_or("observed bytes do not match any legal atomic transaction cut")?,
    };
    println!(
        concat!(
            "MINISANDBOX_INFLIGHT_VERIFY_OK phase={:?} cut={} transactions={} ",
            "offset={} bytes={} state={}"
        ),
        state.phase,
        cut,
        state.aligned_bytes.div_ceil(TRANSACTION_BYTES),
        state.request_offset,
        state.request_bytes,
        config.state.display()
    );
    Ok(())
}

fn match_possible_cut(state: &CrashState, observed: &[[u8; HASH_BYTES]]) -> Option<usize> {
    let transactions = state.aligned_bytes.div_ceil(TRANSACTION_BYTES);
    (0..=transactions).find(|cut| {
        observed.iter().enumerate().all(|(block, hash)| {
            let after_bytes = cut.saturating_mul(TRANSACTION_BYTES);
            let expected = if block * BLOCK_SIZE < after_bytes {
                state.after[block]
            } else {
                state.before[block]
            };
            *hash == expected
        })
    })
}

fn validate_request(offset: u64, length: usize) -> Result<(u64, usize), Box<dyn Error>> {
    if !(SECTOR_SIZE..=MAX_REQUEST_BYTES).contains(&length)
        || !length.is_multiple_of(SECTOR_SIZE)
        || !offset.is_multiple_of(BLOCK_SIZE as u64)
    {
        return Err("request must start on 4 KiB and contain 512 B through 1 MiB".into());
    }
    let end = offset
        .checked_add(u64::try_from(length)?)
        .ok_or("request range overflow")?;
    let aligned_end = end
        .checked_add(u64::try_from(BLOCK_SIZE - 1)?)
        .ok_or("aligned request range overflow")?
        / u64::try_from(BLOCK_SIZE)?
        * u64::try_from(BLOCK_SIZE)?;
    Ok((offset, usize::try_from(aligned_end - offset)?))
}

fn hash_blocks(bytes: &[u8]) -> Vec<[u8; HASH_BYTES]> {
    bytes
        .chunks_exact(BLOCK_SIZE)
        .map(|block| Sha256::digest(block).into())
        .collect()
}

fn require_hashes(
    context: &str,
    bytes: &[u8],
    expected: &[[u8; HASH_BYTES]],
) -> Result<(), Box<dyn Error>> {
    if hash_blocks(bytes) != expected {
        return Err(format!("device content mismatch {context}").into());
    }
    Ok(())
}

fn open_direct(path: &Path) -> Result<File, Box<dyn Error>> {
    Ok(OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_DIRECT | libc::O_DSYNC)
        .open(path)?)
}

fn pwrite_once(file: &File, offset: u64, bytes: &[u8]) -> Result<(), Box<dyn Error>> {
    let offset = libc::off_t::try_from(offset)?;
    // SAFETY: `bytes` is live for the call, the direct-I/O caller supplies a
    // suitably aligned allocation, and the validated range fits off_t.
    let written = unsafe {
        libc::pwrite(
            file.as_raw_fd(),
            bytes.as_ptr().cast::<c_void>(),
            bytes.len(),
            offset,
        )
    };
    if written < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    if usize::try_from(written)? != bytes.len() {
        return Err("direct block write completed only partially".into());
    }
    Ok(())
}

fn pread_all(file: &File, offset: u64, bytes: &mut [u8]) -> Result<(), Box<dyn Error>> {
    let mut completed = 0_usize;
    while completed < bytes.len() {
        let current_offset = offset
            .checked_add(u64::try_from(completed)?)
            .ok_or("direct read offset overflow")?;
        // SAFETY: the remaining slice is a live writable allocation and each
        // offset remains sector aligned because successful direct reads are
        // required to complete in sector multiples.
        let read = unsafe {
            libc::pread(
                file.as_raw_fd(),
                bytes[completed..].as_mut_ptr().cast::<c_void>(),
                bytes.len() - completed,
                libc::off_t::try_from(current_offset)?,
            )
        };
        if read < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        if read == 0 {
            return Err("unexpected EOF from block device".into());
        }
        let read = usize::try_from(read)?;
        if !read.is_multiple_of(SECTOR_SIZE) {
            return Err("direct block read returned a non-sector length".into());
        }
        completed = completed.checked_add(read).ok_or("direct read overflow")?;
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
        .ok_or("device range overflow")?;
    if end > device_size(file)? {
        return Err("in-flight oracle range exceeds the device".into());
    }
    Ok(())
}

fn persist_state(path: &Path, state: &CrashState) -> Result<(), Box<dyn Error>> {
    let bytes = encode_state(state)?;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let temporary = parent.join(format!(".inflight-{}-{nonce:x}.tmp", process::id()));
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

fn encode_state(state: &CrashState) -> Result<Vec<u8>, Box<dyn Error>> {
    let block_count = state.aligned_bytes / BLOCK_SIZE;
    if state.before.len() != block_count || state.after.len() != block_count {
        return Err("in-flight state shape is inconsistent".into());
    }
    let mut bytes = Vec::with_capacity(
        72_usize
            .checked_add(
                block_count
                    .checked_mul(2 * HASH_BYTES)
                    .ok_or("state overflow")?,
            )
            .and_then(|length| length.checked_add(HASH_BYTES))
            .ok_or("state overflow")?,
    );
    bytes.extend_from_slice(STATE_MAGIC);
    bytes.extend_from_slice(&STATE_VERSION.to_be_bytes());
    bytes.extend_from_slice(&(state.phase as u32).to_be_bytes());
    bytes.extend_from_slice(&state.aligned_offset.to_be_bytes());
    bytes.extend_from_slice(&u64::try_from(state.aligned_bytes)?.to_be_bytes());
    bytes.extend_from_slice(&state.request_offset.to_be_bytes());
    bytes.extend_from_slice(&u64::try_from(state.request_bytes)?.to_be_bytes());
    bytes.extend_from_slice(&state.seed.to_be_bytes());
    bytes.extend_from_slice(&u64::try_from(block_count)?.to_be_bytes());
    for (before, after) in state.before.iter().zip(&state.after) {
        bytes.extend_from_slice(before);
        bytes.extend_from_slice(after);
    }
    let digest = Sha256::digest(&bytes);
    bytes.extend_from_slice(&digest);
    Ok(bytes)
}

fn load_state(path: &Path) -> Result<CrashState, Box<dyn Error>> {
    if fs::metadata(path)?.len() > MAX_STATE_BYTES {
        return Err("in-flight state exceeds the bounded size".into());
    }
    let bytes = fs::read(path)?;
    if bytes.len() < 72 + HASH_BYTES {
        return Err("in-flight state is truncated".into());
    }
    let (body, stored_digest) = bytes.split_at(bytes.len() - HASH_BYTES);
    if Sha256::digest(body).as_slice() != stored_digest {
        return Err("in-flight state digest mismatch".into());
    }
    let mut cursor = body;
    if take(&mut cursor, STATE_MAGIC.len())? != STATE_MAGIC {
        return Err("in-flight state magic mismatch".into());
    }
    if take_u32(&mut cursor)? != STATE_VERSION {
        return Err("unsupported in-flight state version".into());
    }
    let phase = Phase::parse(take_u32(&mut cursor)?)?;
    let aligned_offset = take_u64(&mut cursor)?;
    let aligned_bytes = usize::try_from(take_u64(&mut cursor)?)?;
    let request_offset = take_u64(&mut cursor)?;
    let request_bytes = usize::try_from(take_u64(&mut cursor)?)?;
    let seed = take_u64(&mut cursor)?;
    let block_count = usize::try_from(take_u64(&mut cursor)?)?;
    let (expected_offset, expected_bytes) = validate_request(request_offset, request_bytes)?;
    if aligned_offset != expected_offset
        || aligned_bytes != expected_bytes
        || block_count != aligned_bytes / BLOCK_SIZE
        || cursor.len()
            != block_count
                .checked_mul(2 * HASH_BYTES)
                .ok_or("state overflow")?
    {
        return Err("in-flight state geometry mismatch".into());
    }
    let mut before = Vec::with_capacity(block_count);
    let mut after = Vec::with_capacity(block_count);
    for _ in 0..block_count {
        let mut before_hash = [0_u8; HASH_BYTES];
        before_hash.copy_from_slice(take(&mut cursor, HASH_BYTES)?);
        let mut after_hash = [0_u8; HASH_BYTES];
        after_hash.copy_from_slice(take(&mut cursor, HASH_BYTES)?);
        before.push(before_hash);
        after.push(after_hash);
    }
    Ok(CrashState {
        phase,
        aligned_offset,
        aligned_bytes,
        request_offset,
        request_bytes,
        seed,
        before,
        after,
    })
}

fn take<'a>(cursor: &mut &'a [u8], length: usize) -> Result<&'a [u8], Box<dyn Error>> {
    if cursor.len() < length {
        return Err("in-flight state is truncated".into());
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

fn parse_args(mut args: impl Iterator<Item = String>) -> Result<Config, Box<dyn Error>> {
    let mode = match args.next().as_deref() {
        Some("prepare") => Mode::Prepare,
        Some("overwrite") => Mode::Overwrite,
        Some("verify") => Mode::Verify,
        Some("--help" | "-h") => {
            print_help();
            process::exit(0);
        }
        _ => return Err("first argument must be prepare, overwrite, or verify".into()),
    };
    let mut device = None;
    let mut state = None;
    let mut go_file = None;
    let mut request_offset = 0_u64;
    let mut request_bytes = 1024 * 1024;
    let mut seed = 0x1f11_6a7e_u64;
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--device" => device = Some(PathBuf::from(required(&mut args, "--device")?)),
            "--state" => state = Some(PathBuf::from(required(&mut args, "--state")?)),
            "--go-file" => go_file = Some(PathBuf::from(required(&mut args, "--go-file")?)),
            "--offset" => request_offset = required(&mut args, "--offset")?.parse()?,
            "--bytes" => request_bytes = required(&mut args, "--bytes")?.parse()?,
            "--seed" => seed = parse_u64(&required(&mut args, "--seed")?)?,
            "--help" | "-h" => {
                print_help();
                process::exit(0);
            }
            _ => return Err(format!("unknown argument: {argument}").into()),
        }
    }
    if mode != Mode::Prepare && (request_offset != 0 || request_bytes != MAX_REQUEST_BYTES) {
        return Err("--offset and --bytes are read from state outside prepare mode".into());
    }
    Ok(Config {
        mode,
        device: device.ok_or("missing --device")?,
        state: state.ok_or("missing --state")?,
        go_file,
        request_offset,
        request_bytes,
        seed,
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
        "usage: minisandbox-inflight-oracle prepare|overwrite|verify ",
        "--device /dev/nbdX --state FILE [--go-file FIFO] ",
        "[--offset BYTES] [--bytes BYTES] [--seed N|0xHEX]"
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn sample_state() -> CrashState {
        CrashState {
            phase: Phase::Intent,
            aligned_offset: 0,
            aligned_bytes: 2 * TRANSACTION_BYTES,
            request_offset: 0,
            request_bytes: 2 * TRANSACTION_BYTES,
            seed: 7,
            before: vec![[0x11; HASH_BYTES]; 2 * TRANSACTION_BYTES / BLOCK_SIZE],
            after: vec![[0x22; HASH_BYTES]; 2 * TRANSACTION_BYTES / BLOCK_SIZE],
        }
    }

    #[test]
    fn state_round_trip_rejects_corruption() {
        let directory = TempDir::new().expect("in-flight state tempdir");
        let path = directory.path().join("state");
        let state = sample_state();
        fs::write(&path, encode_state(&state).expect("encode")).expect("write");
        let decoded = load_state(&path).expect("load");
        assert_eq!(decoded.phase, Phase::Intent);
        assert_eq!(decoded.before, state.before);
        assert_eq!(decoded.after, state.after);
        let mut corrupt = fs::read(&path).expect("read");
        corrupt[24] ^= 1;
        fs::write(&path, corrupt).expect("corrupt");
        assert!(load_state(&path).is_err());
    }

    #[test]
    fn possible_values_accept_only_transaction_prefixes() {
        let state = sample_state();
        assert_eq!(match_possible_cut(&state, &state.before), Some(0));
        assert_eq!(match_possible_cut(&state, &state.after), Some(2));
        let mut one_commit = state.before.clone();
        one_commit[..TRANSACTION_BYTES / BLOCK_SIZE]
            .copy_from_slice(&state.after[..TRANSACTION_BYTES / BLOCK_SIZE]);
        assert_eq!(match_possible_cut(&state, &one_commit), Some(1));
        one_commit[TRANSACTION_BYTES / BLOCK_SIZE + 1] = state.after[0];
        assert_eq!(match_possible_cut(&state, &one_commit), None);
    }
}
