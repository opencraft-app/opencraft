//! Standalone Linux NBD attachment for the reference storage engine.

use std::{
    env,
    error::Error,
    io::{self, Write},
    path::PathBuf,
    process,
};

#[cfg(feature = "fault-injection")]
use std::{thread, time::Duration};

#[cfg(feature = "fault-injection")]
use minisandbox_nbd_frontend::BlockDevice;
use minisandbox_nbd_frontend::{AttachedNbd, OnlineSettlerConfig, SqliteBlockBackend};

const DEFAULT_SIZE: u64 = 2 * 1024 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_SECONDS: u32 = 30;
const MAX_REQUEST_TIMEOUT_SECONDS: u32 = 24 * 60 * 60;

#[derive(Debug)]
struct Config {
    device: PathBuf,
    database: PathBuf,
    cos_root: PathBuf,
    volume_id: String,
    size: u64,
    request_timeout_seconds: u32,
    settle_on_disconnect: bool,
    settle_max_passes: u64,
    online_settler: Option<OnlineSettlerConfig>,
    #[cfg(feature = "fault-injection")]
    test_stall_first_write_ms: Option<u64>,
    #[cfg(feature = "fault-injection")]
    test_session_id: Option<String>,
}

fn main() -> Result<(), Box<dyn Error>> {
    let config = parse_args(env::args().skip(1))?;
    #[cfg(feature = "fault-injection")]
    let mut backend = if let Some(session_id) = config.test_session_id.as_deref() {
        SqliteBlockBackend::open_for_fault_test(
            &config.database,
            &config.cos_root,
            &config.volume_id,
            config.size,
            session_id,
        )?
    } else {
        SqliteBlockBackend::open(
            &config.database,
            &config.cos_root,
            &config.volume_id,
            config.size,
        )?
    };
    #[cfg(not(feature = "fault-injection"))]
    let mut backend = SqliteBlockBackend::open(
        &config.database,
        &config.cos_root,
        &config.volume_id,
        config.size,
    )?;
    if let Some(settler) = config.online_settler {
        backend.start_online_settler(settler)?;
    }
    let writer_epoch = backend.writer_epoch();
    let attachment = AttachedNbd::attach_with_timeout(
        &config.device,
        config.size,
        config.request_timeout_seconds,
    )?;
    println!(
        "MINISANDBOX_NBD_READY device={} size={} volume={} writer_epoch={}",
        attachment.device_path().display(),
        config.size,
        config.volume_id,
        writer_epoch
    );
    io::stdout().flush()?;

    #[cfg(feature = "fault-injection")]
    let stats = if let Some(delay_ms) = config.test_stall_first_write_ms {
        let mut stalled = StallFirstWrite::new(&mut backend, delay_ms);
        attachment.run(&mut stalled)?
    } else {
        attachment.run(&mut backend)?
    };
    #[cfg(not(feature = "fault-injection"))]
    let stats = attachment.run(&mut backend)?;
    let online_stats = backend.stop_online_settler(true)?;
    println!(
        concat!(
            "MINISANDBOX_NBD_STOPPED reads={} writes={} flushes={} trims={} ",
            "write_zeroes={} fua_commands={} transport_disconnects={} errors={} ",
            "read_bytes={} written_bytes={}"
        ),
        stats.reads,
        stats.writes,
        stats.flushes,
        stats.trims,
        stats.write_zeroes,
        stats.fua_commands,
        stats.transport_disconnects,
        stats.errors,
        stats.read_bytes,
        stats.written_bytes
    );
    if let Some(stats) = online_stats {
        println!(
            concat!(
                "MINISANDBOX_NBD_ONLINE_SETTLED wakeups={} passes={} packs={} ",
                "published_blocks={} evicted_blocks={} recovered_evictions={} ",
                "max_hot_payload_bytes={} final_hot_payload_bytes={}"
            ),
            stats.wakeups,
            stats.passes,
            stats.packs,
            stats.published_blocks,
            stats.evicted_blocks,
            stats.recovered_evictions,
            stats.max_hot_payload_bytes,
            stats.final_hot_payload_bytes
        );
    }
    if config.settle_on_disconnect {
        let passes = backend.settle_all(config.settle_max_passes)?;
        println!("MINISANDBOX_NBD_SETTLED passes={passes}");
    }
    Ok(())
}

#[allow(clippy::too_many_lines)]
fn parse_args(args: impl Iterator<Item = String>) -> Result<Config, Box<dyn Error>> {
    let mut device = None;
    let mut database = None;
    let mut cos_root = None;
    let mut volume_id = "nbd-volume".to_owned();
    let mut size = DEFAULT_SIZE;
    let mut request_timeout_seconds = DEFAULT_REQUEST_TIMEOUT_SECONDS;
    let mut settle_on_disconnect = false;
    let mut settle_max_passes = 4096;
    let mut online_settle_high_bytes = None;
    let mut online_settle_low_bytes = None;
    let mut online_settle_pack_bytes = 1024 * 1024;
    #[cfg(feature = "fault-injection")]
    let mut test_stall_first_write_ms = None;
    #[cfg(feature = "fault-injection")]
    let mut test_session_id = None;
    let mut args = args;
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--device" => device = Some(PathBuf::from(required(&mut args, "--device")?)),
            "--database" => {
                database = Some(PathBuf::from(required(&mut args, "--database")?));
            }
            "--cos-root" => {
                cos_root = Some(PathBuf::from(required(&mut args, "--cos-root")?));
            }
            "--volume-id" => volume_id = required(&mut args, "--volume-id")?,
            "--size-bytes" => size = required(&mut args, "--size-bytes")?.parse()?,
            "--request-timeout-seconds" => {
                request_timeout_seconds =
                    required(&mut args, "--request-timeout-seconds")?.parse()?;
            }
            "--settle-on-disconnect" => settle_on_disconnect = true,
            "--settle-max-passes" => {
                settle_max_passes = required(&mut args, "--settle-max-passes")?.parse()?;
            }
            "--online-settle-high-bytes" => {
                online_settle_high_bytes =
                    Some(required(&mut args, "--online-settle-high-bytes")?.parse()?);
            }
            "--online-settle-low-bytes" => {
                online_settle_low_bytes =
                    Some(required(&mut args, "--online-settle-low-bytes")?.parse()?);
            }
            "--online-settle-pack-bytes" => {
                online_settle_pack_bytes =
                    required(&mut args, "--online-settle-pack-bytes")?.parse()?;
            }
            #[cfg(feature = "fault-injection")]
            "--test-stall-first-write-ms" => {
                test_stall_first_write_ms =
                    Some(required(&mut args, "--test-stall-first-write-ms")?.parse()?);
            }
            #[cfg(feature = "fault-injection")]
            "--test-session-id" => {
                test_session_id = Some(required(&mut args, "--test-session-id")?);
            }
            "--help" | "-h" => {
                print_help();
                process::exit(0);
            }
            _ => return Err(format!("unknown argument: {argument}").into()),
        }
    }
    if volume_id.is_empty() || settle_max_passes == 0 {
        return Err("volume ID and settle pass limit must be non-zero".into());
    }
    if request_timeout_seconds == 0 || request_timeout_seconds > MAX_REQUEST_TIMEOUT_SECONDS {
        return Err("request timeout must be between 1 and 86400 seconds".into());
    }
    #[cfg(feature = "fault-injection")]
    if matches!(test_stall_first_write_ms, Some(0 | 60_001..)) {
        return Err("test stall must be between 1 and 60000 milliseconds".into());
    }
    #[cfg(feature = "fault-injection")]
    if test_session_id
        .as_ref()
        .is_some_and(|value| value.is_empty() || value.len() > 64)
        || test_session_id.is_some() && test_stall_first_write_ms.is_none()
    {
        return Err("test session ID requires a stall and must be 1..64 bytes".into());
    }
    let online_settler = match (online_settle_high_bytes, online_settle_low_bytes) {
        (Some(high_watermark_bytes), Some(low_watermark_bytes)) => Some(OnlineSettlerConfig {
            high_watermark_bytes,
            low_watermark_bytes,
            max_pack_bytes: online_settle_pack_bytes,
        }),
        (None, None) => None,
        _ => {
            return Err("online settle high and low watermarks must be supplied together".into());
        }
    };
    Ok(Config {
        device: device.ok_or("missing --device")?,
        database: database.ok_or("missing --database")?,
        cos_root: cos_root.ok_or("missing --cos-root")?,
        volume_id,
        size,
        request_timeout_seconds,
        settle_on_disconnect,
        settle_max_passes,
        online_settler,
        #[cfg(feature = "fault-injection")]
        test_stall_first_write_ms,
        #[cfg(feature = "fault-injection")]
        test_session_id,
    })
}

#[cfg(feature = "fault-injection")]
struct StallFirstWrite<'a, B> {
    inner: &'a mut B,
    delay: Duration,
    stalled: bool,
}

#[cfg(feature = "fault-injection")]
impl<'a, B> StallFirstWrite<'a, B> {
    fn new(inner: &'a mut B, delay_ms: u64) -> Self {
        Self {
            inner,
            delay: Duration::from_millis(delay_ms),
            stalled: false,
        }
    }
}

#[cfg(feature = "fault-injection")]
impl<B: BlockDevice> BlockDevice for StallFirstWrite<'_, B> {
    type Error = B::Error;

    fn size(&self) -> u64 {
        self.inner.size()
    }

    fn read_at(&mut self, offset: u64, length: usize) -> Result<Vec<u8>, Self::Error> {
        self.inner.read_at(offset, length)
    }

    fn write_at(&mut self, offset: u64, bytes: &[u8], fua: bool) -> Result<(), Self::Error> {
        if !self.stalled {
            self.stalled = true;
            eprintln!(
                "MINISANDBOX_NBD_TEST_STALL_FIRST_WRITE delay_ms={}",
                self.delay.as_millis()
            );
            thread::sleep(self.delay);
        }
        self.inner.write_at(offset, bytes, fua)
    }

    fn flush(&mut self) -> Result<(), Self::Error> {
        self.inner.flush()
    }

    fn trim(&mut self, offset: u64, length: usize, fua: bool) -> Result<(), Self::Error> {
        self.inner.trim(offset, length, fua)
    }
}

fn required(
    args: &mut impl Iterator<Item = String>,
    option: &str,
) -> Result<String, Box<dyn Error>> {
    args.next()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("missing value for {option}").into())
}

fn print_help() {
    println!(
        "usage: minisandbox-nbd --device /dev/nbdX --database FILE --cos-root DIR \
         [--volume-id ID] [--size-bytes N] [--settle-on-disconnect] \
         [--request-timeout-seconds N] \
         [--settle-max-passes N] [--online-settle-high-bytes N \
         --online-settle-low-bytes N] [--online-settle-pack-bytes N]"
    );
}
