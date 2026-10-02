//! NBD transmission parser and operation-mapping tests.

use std::{
    io::{Cursor, Read, Write},
    os::unix::net::UnixStream,
    thread,
};

use minisandbox_nbd_frontend::{
    BlockDevice, NBD_MAX_REQUEST_BYTES, NBD_MAX_TRIM_BYTES, serve_transmission,
};

const REQUEST_MAGIC: u32 = 0x2560_9513;
const REPLY_MAGIC: u32 = 0x6744_6698;
const CMD_READ: u16 = 0;
const CMD_WRITE: u16 = 1;
const CMD_DISC: u16 = 2;
const CMD_FLUSH: u16 = 3;
const CMD_TRIM: u16 = 4;
const CMD_WRITE_ZEROES: u16 = 6;
const FLAG_FUA: u32 = 1 << 16;
const FLAG_NO_HOLE: u32 = 1 << 17;

#[derive(Debug)]
struct MemoryBackend {
    bytes: Vec<u8>,
    writes: u64,
    flushes: u64,
    trims: u64,
    fua_writes: u64,
}

#[derive(Debug)]
struct BrokenReplyStream {
    input: Cursor<Vec<u8>>,
}

impl Read for BrokenReplyStream {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        self.input.read(bytes)
    }
}

impl Write for BrokenReplyStream {
    fn write(&mut self, _bytes: &[u8]) -> std::io::Result<usize> {
        Err(std::io::Error::from(std::io::ErrorKind::BrokenPipe))
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl MemoryBackend {
    fn new(size: usize) -> Self {
        Self {
            bytes: vec![0; size],
            writes: 0,
            flushes: 0,
            trims: 0,
            fua_writes: 0,
        }
    }
}

impl BlockDevice for MemoryBackend {
    type Error = std::io::Error;

    fn size(&self) -> u64 {
        self.bytes.len() as u64
    }

    fn read_at(&mut self, offset: u64, length: usize) -> Result<Vec<u8>, Self::Error> {
        let start = usize::try_from(offset).expect("test offset fits");
        Ok(self.bytes[start..start + length].to_vec())
    }

    fn write_at(&mut self, offset: u64, bytes: &[u8], fua: bool) -> Result<(), Self::Error> {
        let start = usize::try_from(offset).expect("test offset fits");
        self.bytes[start..start + bytes.len()].copy_from_slice(bytes);
        self.writes += 1;
        self.fua_writes += u64::from(fua);
        Ok(())
    }

    fn flush(&mut self) -> Result<(), Self::Error> {
        self.flushes += 1;
        Ok(())
    }

    fn trim(&mut self, _offset: u64, _length: usize, _fua: bool) -> Result<(), Self::Error> {
        self.trims += 1;
        Ok(())
    }
}

#[test]
fn transmission_maps_read_write_flush_fua_trim_and_zeroes() {
    let (mut client, mut server) = UnixStream::pair().expect("socket pair");
    let worker = thread::spawn(move || {
        let mut backend = MemoryBackend::new(2 * NBD_MAX_REQUEST_BYTES);
        let stats = serve_transmission(&mut server, &mut backend).expect("serve transmission");
        (stats, backend)
    });

    let write = vec![0xa5; 512];
    send_request(&mut client, CMD_WRITE, FLAG_FUA, 1, 512, 512, &write);
    assert_reply(&mut client, 1, 0);

    send_request(&mut client, CMD_READ, 0, 2, 0, 4096, &[]);
    assert_reply(&mut client, 2, 0);
    let mut observed = vec![0; 4096];
    client.read_exact(&mut observed).expect("read data reply");
    assert_eq!(&observed[512..1024], write.as_slice());

    send_request(
        &mut client,
        CMD_WRITE_ZEROES,
        FLAG_FUA | FLAG_NO_HOLE,
        3,
        512,
        512,
        &[],
    );
    assert_reply(&mut client, 3, 0);

    send_request(&mut client, CMD_TRIM, 0, 4, 0, NBD_MAX_TRIM_BYTES, &[]);
    assert_reply(&mut client, 4, 0);
    send_request(
        &mut client,
        CMD_TRIM,
        0,
        5,
        0,
        NBD_MAX_TRIM_BYTES + 512,
        &[],
    );
    assert_reply(&mut client, 5, u32::try_from(libc::EINVAL).expect("errno"));
    send_request(&mut client, CMD_FLUSH, 0, 6, 0, 0, &[]);
    assert_reply(&mut client, 6, 0);

    // The invalid write payload must be consumed so the next request remains
    // framed and independently answerable.
    send_request(
        &mut client,
        CMD_WRITE,
        0,
        7,
        2 * NBD_MAX_REQUEST_BYTES as u64,
        512,
        &[0x7e; 512],
    );
    assert_reply(&mut client, 7, u32::try_from(libc::EINVAL).expect("errno"));
    send_request(&mut client, CMD_READ, 0, 8, 0, 512, &[]);
    assert_reply(&mut client, 8, 0);
    let mut zero = [0_u8; 512];
    client
        .read_exact(&mut zero)
        .expect("read after rejected write");
    assert_eq!(zero, [0; 512]);

    send_request(&mut client, CMD_DISC, 0, 9, 0, 0, &[]);
    drop(client);
    let (stats, backend) = worker.join().expect("join protocol worker");
    assert_eq!(stats.reads, 2);
    assert_eq!(stats.writes, 1);
    assert_eq!(stats.write_zeroes, 1);
    assert_eq!(stats.fua_commands, 2);
    assert_eq!(stats.transport_disconnects, 0);
    assert_eq!(stats.trims, 1);
    assert_eq!(stats.flushes, 1);
    assert_eq!(stats.errors, 2);
    assert_eq!(backend.writes, 2);
    assert_eq!(backend.fua_writes, 2);
    assert_eq!(backend.trims, 1);
    assert_eq!(backend.flushes, 1);
}

#[test]
fn peer_close_during_reply_ends_the_session_without_a_backend_error() {
    let mut request = [0_u8; 28];
    request[0..4].copy_from_slice(&REQUEST_MAGIC.to_be_bytes());
    request[4..8].copy_from_slice(&u32::from(CMD_READ).to_be_bytes());
    request[8..16].copy_from_slice(&1_u64.to_be_bytes());
    request[24..28].copy_from_slice(&512_u32.to_be_bytes());
    let mut stream = BrokenReplyStream {
        input: Cursor::new(request.to_vec()),
    };
    let mut backend = MemoryBackend::new(4096);

    let stats = serve_transmission(&mut stream, &mut backend).expect("peer close ends session");
    assert_eq!(stats.transport_disconnects, 1);
    assert_eq!(stats.errors, 0);
    assert_eq!(
        stats.reads, 0,
        "a reply that never reached the peer is not counted"
    );
}

fn send_request(
    stream: &mut UnixStream,
    command: u16,
    flags: u32,
    handle: u64,
    offset: u64,
    length: usize,
    payload: &[u8],
) {
    let mut request = [0_u8; 28];
    request[0..4].copy_from_slice(&REQUEST_MAGIC.to_be_bytes());
    request[4..8].copy_from_slice(&(flags | u32::from(command)).to_be_bytes());
    request[8..16].copy_from_slice(&handle.to_be_bytes());
    request[16..24].copy_from_slice(&offset.to_be_bytes());
    request[24..28].copy_from_slice(
        &u32::try_from(length)
            .expect("test request length fits")
            .to_be_bytes(),
    );
    stream.write_all(&request).expect("write request header");
    stream.write_all(payload).expect("write request payload");
}

fn assert_reply(stream: &mut UnixStream, expected_handle: u64, expected_error: u32) {
    let mut reply = [0_u8; 16];
    stream.read_exact(&mut reply).expect("read reply");
    assert_eq!(
        u32::from_be_bytes(reply[0..4].try_into().expect("reply magic")),
        REPLY_MAGIC
    );
    assert_eq!(
        u32::from_be_bytes(reply[4..8].try_into().expect("reply error")),
        expected_error
    );
    assert_eq!(
        u64::from_be_bytes(reply[8..16].try_into().expect("reply handle")),
        expected_handle
    );
}
