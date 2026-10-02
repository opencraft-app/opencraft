use std::{
    fs::{self, File, OpenOptions},
    io,
    os::fd::AsRawFd,
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    sync::mpsc,
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use thiserror::Error;

use crate::{
    BlockDevice, NBD_LOGICAL_BLOCK_SIZE, NBD_MAX_TRIM_BYTES, SessionStats,
    protocol::{ProtocolError, is_peer_disconnect, process_queued_request, read_queued_request},
};

const NBD_SET_SOCK: libc::c_ulong = 0xab00;
const NBD_SET_BLKSIZE: libc::c_ulong = 0xab01;
const NBD_DO_IT: libc::c_ulong = 0xab03;
const NBD_CLEAR_SOCK: libc::c_ulong = 0xab04;
const NBD_CLEAR_QUE: libc::c_ulong = 0xab05;
const NBD_SET_SIZE_BLOCKS: libc::c_ulong = 0xab07;
const NBD_DISCONNECT: libc::c_ulong = 0xab08;
const NBD_SET_TIMEOUT: libc::c_ulong = 0xab09;
const NBD_SET_FLAGS: libc::c_ulong = 0xab0a;

const NBD_FLAG_HAS_FLAGS: libc::c_ulong = 1 << 0;
const NBD_FLAG_SEND_FLUSH: libc::c_ulong = 1 << 2;
const NBD_FLAG_SEND_FUA: libc::c_ulong = 1 << 3;
const NBD_FLAG_SEND_TRIM: libc::c_ulong = 1 << 5;
const NBD_FLAG_SEND_WRITE_ZEROES: libc::c_ulong = 1 << 6;
const DEFAULT_NBD_TIMEOUT_SECONDS: u32 = 30;
const MAX_NBD_TIMEOUT_SECONDS: u32 = 24 * 60 * 60;
// Linux 6.7 configures 128 tags for the legacy NBD ioctl path. Keeping twice
// that many fully drained frames prevents socket backpressure from triggering
// the kernel's partial-send/requeue cookie bug while retaining a hard memory
// bound of roughly 256 MiB at the protocol's maximum request size.
const DRAINED_REQUEST_CAPACITY: usize = 256;

/// Linux kernel-NBD attachment or transmission failure.
#[derive(Debug, Error)]
pub enum LinuxNbdError {
    /// Device or socket operation failed.
    #[error(transparent)]
    Io(#[from] io::Error),
    /// NBD transmission framing failed.
    #[error(transparent)]
    Protocol(#[from] ProtocolError),
    /// One setup ioctl failed.
    #[error("Linux NBD ioctl {operation} failed: {source}")]
    Ioctl {
        /// Stable ioctl label.
        operation: &'static str,
        /// Kernel errno.
        source: io::Error,
    },
    /// The `NBD_DO_IT` worker panicked.
    #[error("Linux NBD driver thread panicked")]
    DriverThreadPanicked,
    /// The socket-draining reader worker panicked.
    #[error("Linux NBD reader thread panicked")]
    ReaderThreadPanicked,
    /// Export size is not representable as 512-byte sectors.
    #[error("NBD export size must be a non-zero multiple of 512 bytes")]
    InvalidSize,
    /// The configured kernel request timeout was outside the accepted range.
    #[error("Linux NBD request timeout must be between 1 and 86400 seconds")]
    InvalidTimeout,
    /// The kernel-side Unix socket descriptor was not representable.
    #[error("NBD kernel socket descriptor is invalid")]
    InvalidSocketDescriptor,
}

/// One configured Linux `/dev/nbdX` attachment.
pub struct AttachedNbd {
    device_path: PathBuf,
    control: File,
    server: UnixStream,
    worker: Option<JoinHandle<Result<(), io::Error>>>,
}

impl std::fmt::Debug for AttachedNbd {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AttachedNbd")
            .field("device_path", &self.device_path)
            .finish_non_exhaustive()
    }
}

impl AttachedNbd {
    /// Configures one unused Linux NBD device with a direct Unix socket pair.
    ///
    /// # Errors
    ///
    /// Returns a device, geometry, socket, ioctl, or worker-start error.
    pub fn attach(device_path: &Path, size: u64) -> Result<Self, LinuxNbdError> {
        Self::attach_with_timeout(device_path, size, DEFAULT_NBD_TIMEOUT_SECONDS)
    }

    /// Configures one unused Linux NBD device with an explicit kernel request
    /// timeout in seconds.
    ///
    /// # Errors
    ///
    /// Returns a device, geometry, timeout, socket, ioctl, or worker-start
    /// error.
    pub fn attach_with_timeout(
        device_path: &Path,
        size: u64,
        timeout_seconds: u32,
    ) -> Result<Self, LinuxNbdError> {
        if size == 0 || !size.is_multiple_of(NBD_LOGICAL_BLOCK_SIZE) {
            return Err(LinuxNbdError::InvalidSize);
        }
        if timeout_seconds == 0 || timeout_seconds > MAX_NBD_TIMEOUT_SECONDS {
            return Err(LinuxNbdError::InvalidTimeout);
        }
        let device = OpenOptions::new()
            .read(true)
            .write(true)
            .open(device_path)?;
        let control = device.try_clone()?;
        let (server, kernel_socket) = UnixStream::pair()?;

        let socket_fd = libc::c_ulong::try_from(kernel_socket.as_raw_fd())
            .map_err(|_| LinuxNbdError::InvalidSocketDescriptor)?;
        if let Err(error) = configure_device(&device, socket_fd, size, timeout_seconds) {
            let _ = ioctl_raw(&device, NBD_CLEAR_SOCK, 0);
            return Err(error);
        }
        let worker = thread::Builder::new()
            .name("minisandbox-nbd-driver".to_owned())
            .spawn(move || run_driver(device, kernel_socket))?;
        if let Err(error) = configure_discard_limit(device_path) {
            let _ = ioctl_noarg(&control, NBD_DISCONNECT, "NBD_DISCONNECT");
            let _ = worker.join();
            return Err(error);
        }
        Ok(Self {
            device_path: device_path.to_owned(),
            control,
            server,
            worker: Some(worker),
        })
    }

    /// Returns the configured device node.
    #[must_use]
    pub fn device_path(&self) -> &Path {
        &self.device_path
    }

    /// Serves requests until the kernel disconnects and joins `NBD_DO_IT`.
    ///
    /// # Errors
    ///
    /// Returns a protocol, socket, disconnect, or driver-thread error.
    pub fn run<B: BlockDevice>(mut self, backend: &mut B) -> Result<SessionStats, LinuxNbdError> {
        let session = serve_drained_transmission(&mut self.server, backend);
        let _ = ioctl_noarg(&self.control, NBD_DISCONNECT, "NBD_DISCONNECT");
        let worker = self
            .worker
            .take()
            .ok_or(LinuxNbdError::DriverThreadPanicked)?;
        let driver = worker
            .join()
            .map_err(|_| LinuxNbdError::DriverThreadPanicked)?;
        driver?;
        session
    }
}

fn serve_drained_transmission<B: BlockDevice>(
    server: &mut UnixStream,
    backend: &mut B,
) -> Result<SessionStats, LinuxNbdError> {
    let mut reader_stream = server.try_clone()?;
    let (sender, receiver) = mpsc::sync_channel(DRAINED_REQUEST_CAPACITY);
    let reader = thread::Builder::new()
        .name("minisandbox-nbd-reader".to_owned())
        .spawn(move || -> Result<(), ProtocolError> {
            while let Some(request) = read_queued_request(&mut reader_stream)? {
                let disconnect = request.is_disconnect();
                if sender.send(request).is_err() {
                    break;
                }
                if disconnect {
                    break;
                }
            }
            Ok(())
        })?;

    let mut stats = SessionStats::default();
    let mut processing_error = None;
    let mut peer_disconnected = false;
    let mut stop_reader = false;
    while let Ok(request) = receiver.recv() {
        if request.is_disconnect() {
            break;
        }
        if let Err(error) = process_queued_request(server, backend, &request, &mut stats) {
            stop_reader = true;
            if is_peer_disconnect(&error) {
                stats.transport_disconnects += 1;
                peer_disconnected = true;
            } else {
                processing_error = Some(error);
            }
            break;
        }
    }

    if stop_reader {
        let _ = server.shutdown(std::net::Shutdown::Both);
    }
    drop(receiver);
    let reader_result = reader
        .join()
        .map_err(|_| LinuxNbdError::ReaderThreadPanicked)?;

    if let Some(error) = processing_error {
        return Err(error.into());
    }
    match reader_result {
        Ok(()) => Ok(stats),
        Err(error) if is_peer_disconnect(&error) => {
            stats.transport_disconnects += u64::from(!peer_disconnected);
            Ok(stats)
        }
        Err(error) => Err(error.into()),
    }
}

fn configure_device(
    device: &File,
    socket_fd: libc::c_ulong,
    size: u64,
    timeout_seconds: u32,
) -> Result<(), LinuxNbdError> {
    ioctl_arg(device, NBD_SET_SOCK, socket_fd, "NBD_SET_SOCK")?;
    ioctl_arg(
        device,
        NBD_SET_BLKSIZE,
        NBD_LOGICAL_BLOCK_SIZE,
        "NBD_SET_BLKSIZE",
    )?;
    ioctl_arg(
        device,
        NBD_SET_SIZE_BLOCKS,
        size / NBD_LOGICAL_BLOCK_SIZE,
        "NBD_SET_SIZE_BLOCKS",
    )?;
    ioctl_arg(
        device,
        NBD_SET_TIMEOUT,
        libc::c_ulong::from(timeout_seconds),
        "NBD_SET_TIMEOUT",
    )?;
    ioctl_arg(
        device,
        NBD_SET_FLAGS,
        NBD_FLAG_HAS_FLAGS
            | NBD_FLAG_SEND_FLUSH
            | NBD_FLAG_SEND_FUA
            | NBD_FLAG_SEND_TRIM
            | NBD_FLAG_SEND_WRITE_ZEROES,
        "NBD_SET_FLAGS",
    )
}

fn configure_discard_limit(device_path: &Path) -> Result<(), LinuxNbdError> {
    let device_name = device_path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| {
            name.strip_prefix("nbd").is_some_and(|suffix| {
                !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
            })
        })
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid NBD device name"))?;
    let limit_path = Path::new("/sys/class/block")
        .join(device_name)
        .join("queue/discard_max_bytes");
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if fs::write(&limit_path, NBD_MAX_TRIM_BYTES.to_string()).is_ok() {
            let configured = fs::read_to_string(&limit_path)?
                .trim()
                .parse::<usize>()
                .map_err(|_| {
                    io::Error::new(io::ErrorKind::InvalidData, "invalid discard queue limit")
                })?;
            if configured != 0 && configured <= NBD_MAX_TRIM_BYTES {
                return Ok(());
            }
        }
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "kernel did not enforce the discard queue limit",
            )
            .into());
        }
        thread::sleep(Duration::from_millis(10));
    }
}

impl Drop for AttachedNbd {
    fn drop(&mut self) {
        let _ = ioctl_noarg(&self.control, NBD_DISCONNECT, "NBD_DISCONNECT");
    }
}

#[allow(clippy::needless_pass_by_value)]
fn run_driver(device: File, _kernel_socket: UnixStream) -> Result<(), io::Error> {
    let do_it = ioctl_raw(&device, NBD_DO_IT, 0);
    let _ = ioctl_raw(&device, NBD_CLEAR_QUE, 0);
    let _ = ioctl_raw(&device, NBD_CLEAR_SOCK, 0);
    match do_it {
        Ok(()) => Ok(()),
        Err(error)
            if error.raw_os_error().is_some_and(|errno| {
                [libc::EPIPE, libc::ENOTCONN, libc::EINVAL].contains(&errno)
            }) =>
        {
            Ok(())
        }
        Err(error) => Err(error),
    }
}

fn ioctl_arg(
    file: &File,
    request: libc::c_ulong,
    argument: libc::c_ulong,
    operation: &'static str,
) -> Result<(), LinuxNbdError> {
    ioctl_raw(file, request, argument).map_err(|source| LinuxNbdError::Ioctl { operation, source })
}

fn ioctl_noarg(
    file: &File,
    request: libc::c_ulong,
    operation: &'static str,
) -> Result<(), LinuxNbdError> {
    ioctl_arg(file, request, 0, operation)
}

fn ioctl_raw(
    file: &File,
    request: libc::c_ulong,
    argument: libc::c_ulong,
) -> Result<(), io::Error> {
    // SAFETY: `file` is an open NBD device, the request numbers are Linux UAPI
    // `_IO(0xab, n)` constants, and each argument is the documented unsigned
    // long value or socket descriptor. The kernel copies no userspace pointer.
    let result = unsafe { libc::ioctl(file.as_raw_fd(), request, argument) };
    if result == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::{
        io::{Read, Write},
        sync::mpsc::{Receiver, channel},
        time::Duration,
    };

    #[derive(Debug)]
    struct BlockingBackend {
        bytes: Vec<u8>,
        first_write_release: Option<Receiver<()>>,
    }

    impl BlockDevice for BlockingBackend {
        type Error = io::Error;

        fn size(&self) -> u64 {
            self.bytes.len() as u64
        }

        fn read_at(&mut self, offset: u64, length: usize) -> Result<Vec<u8>, Self::Error> {
            let start = usize::try_from(offset).expect("test offset fits");
            Ok(self.bytes[start..start + length].to_vec())
        }

        fn write_at(&mut self, offset: u64, bytes: &[u8], _fua: bool) -> Result<(), Self::Error> {
            if let Some(release) = self.first_write_release.take() {
                release.recv().map_err(|_| {
                    io::Error::new(io::ErrorKind::BrokenPipe, "release sender closed")
                })?;
            }
            let start = usize::try_from(offset).expect("test offset fits");
            self.bytes[start..start + bytes.len()].copy_from_slice(bytes);
            Ok(())
        }

        fn flush(&mut self) -> Result<(), Self::Error> {
            Ok(())
        }

        fn trim(&mut self, _offset: u64, _length: usize, _fua: bool) -> Result<(), Self::Error> {
            Ok(())
        }
    }

    #[test]
    fn reader_drains_a_full_kernel_queue_while_backend_is_blocked() {
        const REQUESTS: u64 = 128;
        const PAYLOAD_BYTES: usize = 64 * 1024;
        const REQUEST_MAGIC: u32 = 0x2560_9513;
        const REPLY_MAGIC: u32 = 0x6744_6698;
        const CMD_WRITE: u32 = 1;
        const CMD_DISC: u32 = 2;

        let (mut client, mut server) = UnixStream::pair().expect("socket pair");
        let (release_sender, release_receiver) = channel();
        let service = thread::spawn(move || {
            let mut backend = BlockingBackend {
                bytes: vec![0; 128 * PAYLOAD_BYTES],
                first_write_release: Some(release_receiver),
            };
            serve_drained_transmission(&mut server, &mut backend).expect("serve drained requests")
        });

        let mut writer = client.try_clone().expect("clone request socket");
        let (writer_done_sender, writer_done_receiver) = channel();
        let request_writer = thread::spawn(move || {
            let payload = vec![0xa5; PAYLOAD_BYTES];
            for handle in 0..REQUESTS {
                let mut header = [0_u8; 28];
                header[0..4].copy_from_slice(&REQUEST_MAGIC.to_be_bytes());
                header[4..8].copy_from_slice(&CMD_WRITE.to_be_bytes());
                header[8..16].copy_from_slice(&handle.to_be_bytes());
                header[16..24].copy_from_slice(&(handle * PAYLOAD_BYTES as u64).to_be_bytes());
                header[24..28].copy_from_slice(
                    &u32::try_from(PAYLOAD_BYTES)
                        .expect("test payload fits u32")
                        .to_be_bytes(),
                );
                writer.write_all(&header).expect("write request header");
                writer.write_all(&payload).expect("write request payload");
            }
            let mut disconnect = [0_u8; 28];
            disconnect[0..4].copy_from_slice(&REQUEST_MAGIC.to_be_bytes());
            disconnect[4..8].copy_from_slice(&CMD_DISC.to_be_bytes());
            disconnect[8..16].copy_from_slice(&REQUESTS.to_be_bytes());
            writer.write_all(&disconnect).expect("write disconnect");
            writer_done_sender
                .send(())
                .expect("signal writer completion");
        });

        writer_done_receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("reader must drain requests before backend is released");
        release_sender
            .send(())
            .expect("release first backend write");

        for expected_handle in 0..REQUESTS {
            let mut reply = [0_u8; 16];
            client.read_exact(&mut reply).expect("read reply");
            assert_eq!(
                u32::from_be_bytes(reply[0..4].try_into().unwrap()),
                REPLY_MAGIC
            );
            assert_eq!(u32::from_be_bytes(reply[4..8].try_into().unwrap()), 0);
            assert_eq!(
                u64::from_be_bytes(reply[8..16].try_into().unwrap()),
                expected_handle
            );
        }
        request_writer.join().expect("join request writer");
        let stats = service.join().expect("join service");
        assert_eq!(stats.writes, REQUESTS);
        assert_eq!(stats.errors, 0);
    }

    #[test]
    fn zero_timeout_is_rejected_before_opening_the_device() {
        let result = AttachedNbd::attach_with_timeout(
            Path::new("/definitely-not-an-nbd-device"),
            NBD_LOGICAL_BLOCK_SIZE,
            0,
        );
        assert!(matches!(result, Err(LinuxNbdError::InvalidTimeout)));
    }

    #[test]
    fn excessive_timeout_is_rejected_before_opening_the_device() {
        let result = AttachedNbd::attach_with_timeout(
            Path::new("/definitely-not-an-nbd-device"),
            NBD_LOGICAL_BLOCK_SIZE,
            MAX_NBD_TIMEOUT_SECONDS + 1,
        );
        assert!(matches!(result, Err(LinuxNbdError::InvalidTimeout)));
    }
}
