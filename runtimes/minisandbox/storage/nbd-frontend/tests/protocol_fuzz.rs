//! Deterministic structured fuzzing for the bounded NBD transmission parser.

use std::io::{self, Cursor, Read, Write};

use minisandbox_nbd_frontend::{
    BlockDevice, NBD_LOGICAL_BLOCK_SIZE, NBD_MAX_REQUEST_BYTES, NBD_MAX_TRIM_BYTES, ProtocolError,
    SqliteBlockBackend, serve_transmission,
};
use tempfile::TempDir;

const REQUEST_MAGIC: u32 = 0x2560_9513;
const REPLY_MAGIC: u32 = 0x6744_6698;
const EXPORT_SIZE: u64 = 2 * 1024 * 1024;
const CMD_READ: u16 = 0;
const CMD_WRITE: u16 = 1;
const CMD_DISC: u16 = 2;
const CMD_FLUSH: u16 = 3;
const CMD_TRIM: u16 = 4;
const CMD_WRITE_ZEROES: u16 = 6;
const FLAG_FUA: u32 = 1 << 16;
const FLAG_NO_HOLE: u32 = 1 << 17;

#[derive(Debug)]
struct ScriptedStream {
    input: Cursor<Vec<u8>>,
    output: Vec<u8>,
}

impl ScriptedStream {
    fn new(input: Vec<u8>) -> Self {
        Self {
            input: Cursor::new(input),
            output: Vec::new(),
        }
    }
}

impl Read for ScriptedStream {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.input.read(bytes)
    }
}

impl Write for ScriptedStream {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.output.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[derive(Debug, Default)]
struct AuditedBackend {
    reads: u64,
    writes: u64,
    flushes: u64,
    trims: u64,
}

impl BlockDevice for AuditedBackend {
    type Error = io::Error;

    fn size(&self) -> u64 {
        EXPORT_SIZE
    }

    fn read_at(&mut self, offset: u64, length: usize) -> Result<Vec<u8>, Self::Error> {
        assert_data_range(offset, length);
        self.reads += 1;
        Ok(vec![0xa5; length])
    }

    fn write_at(&mut self, offset: u64, bytes: &[u8], _fua: bool) -> Result<(), Self::Error> {
        assert_data_range(offset, bytes.len());
        self.writes += 1;
        Ok(())
    }

    fn flush(&mut self) -> Result<(), Self::Error> {
        self.flushes += 1;
        Ok(())
    }

    fn trim(&mut self, offset: u64, length: usize, _fua: bool) -> Result<(), Self::Error> {
        assert!(valid_trim_range(offset, length));
        self.trims += 1;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug)]
struct Case {
    command: u16,
    flags: u32,
    handle: u64,
    offset: u64,
    length: usize,
}

#[test]
fn deterministic_structured_protocol_fuzz_checks_8192_seeded_cases() {
    const FLAGS: [u32; 6] = [
        0,
        FLAG_FUA,
        FLAG_NO_HOLE,
        FLAG_FUA | FLAG_NO_HOLE,
        1 << 18,
        0xffff_0000,
    ];
    const COMMANDS: [u16; 8] = [
        CMD_READ,
        CMD_WRITE,
        CMD_DISC,
        CMD_FLUSH,
        CMD_TRIM,
        CMD_WRITE_ZEROES,
        5,
        u16::MAX,
    ];
    const LENGTHS: [usize; 14] = [
        0,
        1,
        511,
        512,
        513,
        1024,
        4095,
        4096,
        64 * 1024,
        NBD_MAX_REQUEST_BYTES - 512,
        NBD_MAX_REQUEST_BYTES,
        NBD_MAX_REQUEST_BYTES + 512,
        2 * NBD_MAX_REQUEST_BYTES,
        u32::MAX as usize,
    ];

    for seed in 0_u64..128 {
        let mut state = 0x9e37_79b9_7f4a_7c15_u64 ^ seed.wrapping_mul(0xd134_2543_de82_ef95);
        for ordinal in 0_u64..64 {
            let command = COMMANDS[index(next(&mut state), COMMANDS.len())];
            let flags = FLAGS[index(next(&mut state), FLAGS.len())];
            let length = LENGTHS[index(next(&mut state), LENGTHS.len())];
            let offset = fuzz_offset(&mut state);
            check_case(Case {
                command,
                flags,
                handle: (seed << 32) | ordinal,
                offset,
                length,
            });
        }
    }
}

#[test]
fn truncated_and_malformed_frames_fail_closed_without_backend_calls() {
    for length in 0..28 {
        let mut stream = ScriptedStream::new(vec![0; length]);
        let mut backend = AuditedBackend::default();
        let stats = serve_transmission(&mut stream, &mut backend).expect("EOF is a peer close");
        assert_eq!(stats.transport_disconnects, u64::from(length != 0));
        assert_no_backend_calls(&backend);
        assert!(stream.output.is_empty());
    }

    for bit in 0_u32..32 {
        let mut request = request_header(Case {
            command: CMD_READ,
            flags: 0,
            handle: u64::from(bit),
            offset: 0,
            length: 512,
        });
        let bad_magic = REQUEST_MAGIC ^ (1 << bit);
        request[0..4].copy_from_slice(&bad_magic.to_be_bytes());
        let mut stream = ScriptedStream::new(request);
        let mut backend = AuditedBackend::default();
        assert!(matches!(
            serve_transmission(&mut stream, &mut backend),
            Err(ProtocolError::InvalidMagic)
        ));
        assert_no_backend_calls(&backend);
        assert!(stream.output.is_empty());
    }

    let mut partial_write = request_header(Case {
        command: CMD_WRITE,
        flags: 0,
        handle: 7,
        offset: 0,
        length: 512,
    });
    partial_write.extend_from_slice(&vec![0x5a; 511]);
    let mut stream = ScriptedStream::new(partial_write);
    let mut backend = AuditedBackend::default();
    let stats = serve_transmission(&mut stream, &mut backend).expect("partial payload closes peer");
    assert_eq!(stats.transport_disconnects, 1);
    assert_no_backend_calls(&backend);
    assert!(stream.output.is_empty());
}

#[test]
fn oversized_write_is_fatal_after_only_the_fixed_header() {
    let request = request_header(Case {
        command: CMD_WRITE,
        flags: 0,
        handle: 9,
        offset: 0,
        length: u32::MAX as usize,
    });
    let mut stream = ScriptedStream::new(request);
    let mut backend = AuditedBackend::default();
    assert!(matches!(
        serve_transmission(&mut stream, &mut backend),
        Err(ProtocolError::RequestTooLarge(length)) if length == u32::MAX as usize
    ));
    assert_eq!(stream.input.position(), 28);
    assert_no_backend_calls(&backend);
    assert!(stream.output.is_empty());
}

#[test]
fn adversarial_protocol_frames_cannot_select_or_modify_a_sibling_volume() {
    let directory = TempDir::new().expect("volume isolation tempdir");
    let database = directory.path().join("blocks.db");
    let cos_root = directory.path().join("cos");
    let sentinel = vec![0xb6; 4096];

    {
        let mut sibling =
            SqliteBlockBackend::open(&database, &cos_root, "sibling-volume", EXPORT_SIZE)
                .expect("open sibling volume");
        sibling
            .write_at(0, &sentinel, true)
            .expect("write sibling sentinel");
    }

    {
        let mut bound = SqliteBlockBackend::open(&database, &cos_root, "bound-volume", EXPORT_SIZE)
            .expect("open protocol-bound volume");
        for case in [
            Case {
                command: CMD_WRITE,
                flags: FLAG_FUA,
                handle: 1,
                offset: 0,
                length: 4096,
            },
            Case {
                command: CMD_WRITE_ZEROES,
                flags: FLAG_FUA,
                handle: 2,
                offset: 4096,
                length: 4096,
            },
            Case {
                command: CMD_WRITE,
                flags: 0,
                handle: 3,
                offset: EXPORT_SIZE,
                length: 512,
            },
            Case {
                command: u16::MAX,
                flags: 0xffff_0000,
                handle: 4,
                offset: u64::MAX - 511,
                length: 512,
            },
            Case {
                command: CMD_WRITE,
                flags: 0,
                handle: 5,
                offset: 0,
                length: u32::MAX as usize,
            },
        ] {
            let mut input = request_header(case);
            if case.command == CMD_WRITE && case.length <= NBD_MAX_REQUEST_BYTES {
                input.resize(28 + case.length, 0x5a);
            }
            let mut stream = ScriptedStream::new(input);
            let _result = serve_transmission(&mut stream, &mut bound);
        }
        assert_eq!(
            bound.read_at(0, 4096).expect("read bound volume"),
            vec![0x5a; 4096]
        );
    }

    let mut sibling = SqliteBlockBackend::open(&database, &cos_root, "sibling-volume", EXPORT_SIZE)
        .expect("reopen sibling volume");
    assert_eq!(
        sibling
            .read_at(0, sentinel.len())
            .expect("read isolated sibling"),
        sentinel
    );
}

fn check_case(case: Case) {
    let mut input = request_header(case);
    if case.command == CMD_WRITE && case.length <= NBD_MAX_REQUEST_BYTES {
        input.resize(28 + case.length, 0x5a);
    }
    let mut stream = ScriptedStream::new(input);
    let mut backend = AuditedBackend::default();
    let result = serve_transmission(&mut stream, &mut backend);

    if !matches!(
        case.command,
        CMD_READ | CMD_WRITE | CMD_DISC | CMD_FLUSH | CMD_TRIM | CMD_WRITE_ZEROES
    ) {
        assert!(matches!(
            result,
            Err(ProtocolError::UnsupportedCommand(command)) if command == case.command
        ));
        assert_no_backend_calls(&backend);
        assert!(stream.output.is_empty());
        return;
    }
    if case.command == CMD_DISC {
        assert!(result.is_ok());
        assert_no_backend_calls(&backend);
        assert!(stream.output.is_empty());
        return;
    }
    if case.command == CMD_WRITE && case.length > NBD_MAX_REQUEST_BYTES {
        assert!(matches!(
            result,
            Err(ProtocolError::RequestTooLarge(length)) if length == case.length
        ));
        assert_no_backend_calls(&backend);
        assert!(stream.output.is_empty());
        return;
    }

    let stats = result.expect("recognized bounded request returns a reply");
    let valid = valid_case(case);
    assert_reply(&stream.output, case, valid);
    assert_eq!(stats.errors, u64::from(!valid));
    if !valid {
        assert_no_backend_calls(&backend);
        return;
    }

    match case.command {
        CMD_READ => {
            assert_eq!(backend.reads, 1);
            assert_eq!(stats.reads, 1);
            assert_eq!(stream.output.len(), 16 + case.length);
            assert!(stream.output[16..].iter().all(|byte| *byte == 0xa5));
        }
        CMD_WRITE => {
            assert_eq!(backend.writes, 1);
            assert_eq!(stats.writes, 1);
        }
        CMD_FLUSH => {
            assert_eq!(backend.flushes, 1);
            assert_eq!(stats.flushes, 1);
        }
        CMD_TRIM => {
            assert_eq!(backend.trims, 1);
            assert_eq!(stats.trims, 1);
        }
        CMD_WRITE_ZEROES => {
            assert_eq!(backend.writes, 1);
            assert_eq!(stats.write_zeroes, 1);
        }
        _ => unreachable!("commands handled above"),
    }
}

fn request_header(case: Case) -> Vec<u8> {
    let mut request = vec![0_u8; 28];
    request[0..4].copy_from_slice(&REQUEST_MAGIC.to_be_bytes());
    request[4..8].copy_from_slice(&(case.flags | u32::from(case.command)).to_be_bytes());
    request[8..16].copy_from_slice(&case.handle.to_be_bytes());
    request[16..24].copy_from_slice(&case.offset.to_be_bytes());
    request[24..28].copy_from_slice(
        &u32::try_from(case.length)
            .expect("fuzz length is representable on the wire")
            .to_be_bytes(),
    );
    request
}

fn valid_case(case: Case) -> bool {
    match case.command {
        CMD_READ => case.flags == 0 && valid_data_range(case.offset, case.length),
        CMD_WRITE => case.flags & !FLAG_FUA == 0 && valid_data_range(case.offset, case.length),
        CMD_FLUSH => case.flags == 0 && case.offset == 0 && case.length == 0,
        CMD_TRIM => case.flags & !FLAG_FUA == 0 && valid_trim_range(case.offset, case.length),
        CMD_WRITE_ZEROES => {
            case.flags & !(FLAG_FUA | FLAG_NO_HOLE) == 0
                && valid_data_range(case.offset, case.length)
        }
        _ => false,
    }
}

fn valid_data_range(offset: u64, length: usize) -> bool {
    length > 0
        && length <= NBD_MAX_REQUEST_BYTES
        && aligned(offset, length)
        && within_export(offset, length)
}

fn valid_trim_range(offset: u64, length: usize) -> bool {
    length > 0
        && length <= NBD_MAX_TRIM_BYTES
        && aligned(offset, length)
        && within_export(offset, length)
}

fn aligned(offset: u64, length: usize) -> bool {
    offset.is_multiple_of(NBD_LOGICAL_BLOCK_SIZE)
        && length.is_multiple_of(usize::try_from(NBD_LOGICAL_BLOCK_SIZE).expect("sector fits"))
}

fn within_export(offset: u64, length: usize) -> bool {
    u64::try_from(length)
        .ok()
        .and_then(|length| offset.checked_add(length))
        .is_some_and(|end| end <= EXPORT_SIZE)
}

fn assert_data_range(offset: u64, length: usize) {
    assert!(valid_data_range(offset, length));
}

fn assert_no_backend_calls(backend: &AuditedBackend) {
    assert_eq!(backend.reads, 0);
    assert_eq!(backend.writes, 0);
    assert_eq!(backend.flushes, 0);
    assert_eq!(backend.trims, 0);
}

fn assert_reply(output: &[u8], case: Case, valid: bool) {
    let reply_bytes = if valid && case.command == CMD_READ {
        &output[..16]
    } else {
        assert_eq!(output.len(), 16);
        output
    };
    assert_eq!(
        u32::from_be_bytes(reply_bytes[0..4].try_into().expect("reply magic")),
        REPLY_MAGIC
    );
    assert_eq!(
        u32::from_be_bytes(reply_bytes[4..8].try_into().expect("reply errno")),
        if valid { 0 } else { libc::EINVAL as u32 }
    );
    assert_eq!(&reply_bytes[8..16], &case.handle.to_be_bytes());
}

fn fuzz_offset(state: &mut u64) -> u64 {
    match next(state) % 10 {
        0 => 0,
        1 => 1,
        2 => 511,
        3 => 512,
        4 => EXPORT_SIZE - 512,
        5 => EXPORT_SIZE,
        6 => EXPORT_SIZE + 512,
        7 => u64::MAX - 511,
        8 => (next(state) % (EXPORT_SIZE / 512)) * 512,
        _ => next(state) % (EXPORT_SIZE + 4096),
    }
}

fn next(state: &mut u64) -> u64 {
    *state ^= *state >> 12;
    *state ^= *state << 25;
    *state ^= *state >> 27;
    state.wrapping_mul(0x2545_f491_4f6c_dd1d)
}

fn index(value: u64, length: usize) -> usize {
    usize::try_from(value % u64::try_from(length).expect("small corpus length"))
        .expect("corpus index fits")
}
