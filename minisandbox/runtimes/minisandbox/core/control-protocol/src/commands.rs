//! Strict structured-exec and terminal codecs.

use crate::{
    MAX_COMMAND_ARGUMENTS, MAX_COMMAND_ENVIRONMENT, MAX_FRAME_PAYLOAD, MAX_PATH_BYTES, WireError,
    validate_path,
};

const COMMAND_FIXED_SIZE: usize = 40;
const ACTION_REQUEST_FIXED_SIZE: usize = 8;
const ACTION_RESULT_SIZE: usize = 16;
const FLAG_PTY: u32 = 1;
const FLAG_USER_IDS: u32 = 1 << 1;
const FLAG_USER_NAME: u32 = 1 << 2;
const KNOWN_FLAGS: u32 = FLAG_PTY | FLAG_USER_IDS | FLAG_USER_NAME;
const NO_ID: u32 = u32::MAX;
const MAX_USER_BYTES: usize = 256;

/// Initial and resized terminal dimensions.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WirePtySize {
    /// Character rows; must be nonzero.
    pub rows: u16,
    /// Character columns; must be nonzero.
    pub columns: u16,
    /// Optional horizontal pixel count.
    pub pixel_width: u16,
    /// Optional vertical pixel count.
    pub pixel_height: u16,
}

impl WirePtySize {
    /// Encodes one canonical eight-byte terminal size.
    ///
    /// # Errors
    ///
    /// Rejects zero rows or columns.
    pub fn encode(self) -> Result<[u8; 8], WireError> {
        self.validate()?;
        let mut bytes = [0_u8; 8];
        bytes[0..2].copy_from_slice(&self.rows.to_le_bytes());
        bytes[2..4].copy_from_slice(&self.columns.to_le_bytes());
        bytes[4..6].copy_from_slice(&self.pixel_width.to_le_bytes());
        bytes[6..8].copy_from_slice(&self.pixel_height.to_le_bytes());
        Ok(bytes)
    }

    /// Decodes one canonical eight-byte terminal size.
    ///
    /// # Errors
    ///
    /// Rejects zero rows or columns.
    pub fn decode(bytes: &[u8]) -> Result<Self, WireError> {
        if bytes.len() != 8 {
            return Err(WireError::NonCanonical);
        }
        let size = Self {
            rows: read_u16(bytes, 0),
            columns: read_u16(bytes, 2),
            pixel_width: read_u16(bytes, 4),
            pixel_height: read_u16(bytes, 6),
        };
        size.validate()?;
        Ok(size)
    }

    fn validate(self) -> Result<(), WireError> {
        if self.rows == 0 || self.columns == 0 {
            Err(WireError::NonCanonical)
        } else {
            Ok(())
        }
    }
}

/// User selection performed directly by the agent before `execve`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WireUser {
    /// Retains the agent credentials (root in the maintained guest).
    Current,
    /// Uses explicit numeric real/effective uid and gid values.
    Ids {
        /// Numeric user ID.
        uid: u32,
        /// Numeric group ID.
        gid: u32,
    },
    /// Resolves a user from the guest's `/etc/passwd` without invoking NSS helpers.
    Name(Vec<u8>),
}

/// Fully validated direct-exec request with raw Unix bytes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WireCommandSpec {
    /// Absolute executable path. It is never interpreted by a shell or PATH search.
    pub program: Vec<u8>,
    /// Arguments following the executable's conventional `argv[0]`.
    pub arguments: Vec<Vec<u8>>,
    /// Complete environment supplied after `env_clear`.
    pub environment: Vec<(Vec<u8>, Vec<u8>)>,
    /// Absolute working directory.
    pub cwd: Vec<u8>,
    /// Child credentials.
    pub user: WireUser,
    /// Allocates and attaches a PTY when present.
    pub terminal: Option<WirePtySize>,
    /// Total command lifetime in milliseconds; zero disables the deadline.
    pub timeout_ms: u64,
}

impl WireCommandSpec {
    /// Encodes one canonical request bounded to a single control frame.
    ///
    /// # Errors
    ///
    /// Rejects invalid paths, counts, strings, credentials, or aggregate size.
    pub fn encode(&self) -> Result<Vec<u8>, WireError> {
        validate_spec(self)?;
        let mut flags = 0_u32;
        let (uid, gid, user) = match &self.user {
            WireUser::Current => (NO_ID, NO_ID, &[][..]),
            WireUser::Ids { uid, gid } => {
                flags |= FLAG_USER_IDS;
                (*uid, *gid, &[][..])
            }
            WireUser::Name(name) => {
                flags |= FLAG_USER_NAME;
                (NO_ID, NO_ID, name.as_slice())
            }
        };
        let terminal = self.terminal.unwrap_or(WirePtySize {
            rows: 0,
            columns: 0,
            pixel_width: 0,
            pixel_height: 0,
        });
        if self.terminal.is_some() {
            flags |= FLAG_PTY;
        }
        let mut bytes = vec![0_u8; COMMAND_FIXED_SIZE];
        bytes[0..4].copy_from_slice(&flags.to_le_bytes());
        bytes[4..8].copy_from_slice(&uid.to_le_bytes());
        bytes[8..12].copy_from_slice(&gid.to_le_bytes());
        bytes[12..14].copy_from_slice(&terminal.rows.to_le_bytes());
        bytes[14..16].copy_from_slice(&terminal.columns.to_le_bytes());
        bytes[16..18].copy_from_slice(&terminal.pixel_width.to_le_bytes());
        bytes[18..20].copy_from_slice(&terminal.pixel_height.to_le_bytes());
        write_u16(&mut bytes, 20, self.arguments.len())?;
        write_u16(&mut bytes, 22, self.environment.len())?;
        write_u16(&mut bytes, 24, self.program.len())?;
        write_u16(&mut bytes, 26, self.cwd.len())?;
        write_u16(&mut bytes, 28, user.len())?;
        bytes[32..40].copy_from_slice(&self.timeout_ms.to_le_bytes());
        append(&mut bytes, &self.program)?;
        append(&mut bytes, &self.cwd)?;
        append(&mut bytes, user)?;
        for argument in &self.arguments {
            append_length_prefixed(&mut bytes, argument)?;
        }
        for (key, value) in &self.environment {
            append_length_prefixed(&mut bytes, key)?;
            append_length_prefixed(&mut bytes, value)?;
        }
        if bytes.len() > MAX_FRAME_PAYLOAD {
            return Err(WireError::PayloadTooLarge);
        }
        Ok(bytes)
    }

    /// Decodes one request from an untrusted peer.
    ///
    /// # Errors
    ///
    /// Rejects truncation, trailing bytes, unknown flags, invalid fields, or bounds.
    pub fn decode(bytes: &[u8]) -> Result<Self, WireError> {
        if bytes.len() < COMMAND_FIXED_SIZE || bytes.len() > MAX_FRAME_PAYLOAD {
            return Err(WireError::NonCanonical);
        }
        let flags = read_u32(bytes, 0);
        if flags & !KNOWN_FLAGS != 0 || bytes[30..32] != [0, 0] {
            return Err(WireError::NonCanonical);
        }
        let uid = read_u32(bytes, 4);
        let gid = read_u32(bytes, 8);
        let raw_terminal = WirePtySize {
            rows: read_u16(bytes, 12),
            columns: read_u16(bytes, 14),
            pixel_width: read_u16(bytes, 16),
            pixel_height: read_u16(bytes, 18),
        };
        let argument_count = usize::from(read_u16(bytes, 20));
        let environment_count = usize::from(read_u16(bytes, 22));
        if argument_count > MAX_COMMAND_ARGUMENTS || environment_count > MAX_COMMAND_ENVIRONMENT {
            return Err(WireError::NonCanonical);
        }
        let program_len = usize::from(read_u16(bytes, 24));
        let cwd_len = usize::from(read_u16(bytes, 26));
        let user_len = usize::from(read_u16(bytes, 28));
        let timeout_ms = read_u64(bytes, 32);
        let mut cursor = COMMAND_FIXED_SIZE;
        let program = take(bytes, &mut cursor, program_len)?.to_vec();
        let cwd = take(bytes, &mut cursor, cwd_len)?.to_vec();
        let user_name = take(bytes, &mut cursor, user_len)?.to_vec();
        let mut arguments = Vec::with_capacity(argument_count);
        for _ in 0..argument_count {
            arguments.push(take_length_prefixed(bytes, &mut cursor)?.to_vec());
        }
        let mut environment = Vec::with_capacity(environment_count);
        for _ in 0..environment_count {
            let key = take_length_prefixed(bytes, &mut cursor)?.to_vec();
            let value = take_length_prefixed(bytes, &mut cursor)?.to_vec();
            environment.push((key, value));
        }
        if cursor != bytes.len() {
            return Err(WireError::NonCanonical);
        }
        let user = match flags & (FLAG_USER_IDS | FLAG_USER_NAME) {
            0 if uid == NO_ID && gid == NO_ID && user_name.is_empty() => WireUser::Current,
            FLAG_USER_IDS if uid != NO_ID && gid != NO_ID && user_name.is_empty() => {
                WireUser::Ids { uid, gid }
            }
            FLAG_USER_NAME if uid == NO_ID && gid == NO_ID && !user_name.is_empty() => {
                WireUser::Name(user_name)
            }
            _ => return Err(WireError::NonCanonical),
        };
        let terminal = if flags & FLAG_PTY != 0 {
            raw_terminal.validate()?;
            Some(raw_terminal)
        } else if raw_terminal
            == (WirePtySize {
                rows: 0,
                columns: 0,
                pixel_width: 0,
                pixel_height: 0,
            })
        {
            None
        } else {
            return Err(WireError::NonCanonical);
        };
        let spec = Self {
            program,
            arguments,
            environment,
            cwd,
            user,
            terminal,
            timeout_ms,
        };
        validate_spec(&spec)?;
        Ok(spec)
    }
}

/// Encodes a nonzero action identifier followed by bounded action bytes.
///
/// # Errors
///
/// Rejects identifier zero or an aggregate payload larger than one frame.
pub fn encode_action_request(action_id: u64, payload: &[u8]) -> Result<Vec<u8>, WireError> {
    if action_id == 0 {
        return Err(WireError::NonCanonical);
    }
    let length = ACTION_REQUEST_FIXED_SIZE
        .checked_add(payload.len())
        .filter(|length| *length <= MAX_FRAME_PAYLOAD)
        .ok_or(WireError::PayloadTooLarge)?;
    let mut encoded = Vec::with_capacity(length);
    encoded.extend_from_slice(&action_id.to_le_bytes());
    encoded.extend_from_slice(payload);
    Ok(encoded)
}

/// Decodes a nonzero action identifier and borrows its remaining bytes.
///
/// # Errors
///
/// Rejects truncation, identifier zero, or an oversized aggregate payload.
pub fn decode_action_request(bytes: &[u8]) -> Result<(u64, &[u8]), WireError> {
    if !(ACTION_REQUEST_FIXED_SIZE..=MAX_FRAME_PAYLOAD).contains(&bytes.len()) {
        return Err(WireError::NonCanonical);
    }
    let action_id = read_u64(bytes, 0);
    if action_id == 0 {
        return Err(WireError::NonCanonical);
    }
    Ok((action_id, &bytes[ACTION_REQUEST_FIXED_SIZE..]))
}

/// Result of one stdin, signal, or PTY-resize action.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WireActionResult {
    /// Nonzero identifier copied from the request.
    pub action_id: u64,
    /// Number of stdin bytes accepted; zero for other actions and failures.
    pub accepted_bytes: u32,
    /// Positive Linux errno, or zero for success.
    pub errno: i32,
}

impl WireActionResult {
    /// Encodes one canonical fixed-size result.
    ///
    /// # Errors
    ///
    /// Rejects zero identifiers, invalid errno values, or failure byte counts.
    pub fn encode(self) -> Result<[u8; ACTION_RESULT_SIZE], WireError> {
        self.validate()?;
        let mut bytes = [0_u8; ACTION_RESULT_SIZE];
        bytes[0..8].copy_from_slice(&self.action_id.to_le_bytes());
        bytes[8..12].copy_from_slice(&self.accepted_bytes.to_le_bytes());
        bytes[12..16].copy_from_slice(&self.errno.to_le_bytes());
        Ok(bytes)
    }

    /// Decodes one canonical fixed-size result.
    ///
    /// # Errors
    ///
    /// Rejects every noncanonical field before the host consumes it.
    pub fn decode(bytes: &[u8]) -> Result<Self, WireError> {
        if bytes.len() != ACTION_RESULT_SIZE {
            return Err(WireError::NonCanonical);
        }
        let result = Self {
            action_id: read_u64(bytes, 0),
            accepted_bytes: read_u32(bytes, 8),
            errno: read_i32(bytes, 12),
        };
        result.validate()?;
        Ok(result)
    }

    fn validate(self) -> Result<(), WireError> {
        let max_stdin = MAX_FRAME_PAYLOAD - ACTION_REQUEST_FIXED_SIZE;
        if self.action_id == 0
            || !(0..=4095).contains(&self.errno)
            || usize::try_from(self.accepted_bytes).map_or(true, |count| count > max_stdin)
            || (self.errno != 0 && self.accepted_bytes != 0)
        {
            Err(WireError::NonCanonical)
        } else {
            Ok(())
        }
    }
}

fn validate_spec(spec: &WireCommandSpec) -> Result<(), WireError> {
    validate_path(&spec.program)?;
    validate_path(&spec.cwd)?;
    if spec.arguments.len() > MAX_COMMAND_ARGUMENTS
        || spec.environment.len() > MAX_COMMAND_ENVIRONMENT
        || spec
            .arguments
            .iter()
            .any(|argument| argument.len() > MAX_PATH_BYTES || argument.contains(&0))
        || spec.environment.iter().any(|(key, value)| {
            key.is_empty()
                || key.len() > MAX_PATH_BYTES
                || value.len() > u16::MAX as usize
                || key.contains(&0)
                || key.contains(&b'=')
                || value.contains(&0)
        })
    {
        return Err(WireError::NonCanonical);
    }
    match &spec.user {
        WireUser::Current => {}
        WireUser::Ids { uid, gid } if *uid != NO_ID && *gid != NO_ID => {}
        WireUser::Name(name)
            if !name.is_empty()
                && name.len() <= MAX_USER_BYTES
                && !name.contains(&0)
                && !name.contains(&b':') => {}
        WireUser::Ids { .. } | WireUser::Name(_) => return Err(WireError::NonCanonical),
    }
    if let Some(terminal) = spec.terminal {
        terminal.validate()?;
    }
    Ok(())
}

fn append(bytes: &mut Vec<u8>, value: &[u8]) -> Result<(), WireError> {
    let length = bytes
        .len()
        .checked_add(value.len())
        .ok_or(WireError::PayloadTooLarge)?;
    if length > MAX_FRAME_PAYLOAD {
        return Err(WireError::PayloadTooLarge);
    }
    bytes.extend_from_slice(value);
    Ok(())
}

fn append_length_prefixed(bytes: &mut Vec<u8>, value: &[u8]) -> Result<(), WireError> {
    let length = u16::try_from(value.len()).map_err(|_| WireError::PayloadTooLarge)?;
    append(bytes, &length.to_le_bytes())?;
    append(bytes, value)
}

fn take<'a>(bytes: &'a [u8], cursor: &mut usize, length: usize) -> Result<&'a [u8], WireError> {
    let end = cursor
        .checked_add(length)
        .ok_or(WireError::PayloadTooLarge)?;
    let value = bytes.get(*cursor..end).ok_or(WireError::NonCanonical)?;
    *cursor = end;
    Ok(value)
}

fn take_length_prefixed<'a>(bytes: &'a [u8], cursor: &mut usize) -> Result<&'a [u8], WireError> {
    let length_bytes = take(bytes, cursor, 2)?;
    let length = usize::from(u16::from_le_bytes([length_bytes[0], length_bytes[1]]));
    take(bytes, cursor, length)
}

fn write_u16(bytes: &mut [u8], offset: usize, value: usize) -> Result<(), WireError> {
    let value = u16::try_from(value).map_err(|_| WireError::PayloadTooLarge)?;
    bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
    Ok(())
}

fn read_u16(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(bytes[offset..offset + 2].try_into().expect("checked range"))
}

fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("checked range"))
}

fn read_i32(bytes: &[u8], offset: usize) -> i32 {
    i32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("checked range"))
}

fn read_u64(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(bytes[offset..offset + 8].try_into().expect("checked range"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn example() -> WireCommandSpec {
        WireCommandSpec {
            program: b"/usr/bin/python3".to_vec(),
            arguments: vec![b"-c".to_vec(), b"print('ok')".to_vec()],
            environment: vec![(b"LANG".to_vec(), b"C.UTF-8".to_vec())],
            cwd: b"/workspace".to_vec(),
            user: WireUser::Name(b"sandbox".to_vec()),
            terminal: Some(WirePtySize {
                rows: 24,
                columns: 80,
                pixel_width: 0,
                pixel_height: 0,
            }),
            timeout_ms: 12_345,
        }
    }

    #[test]
    fn command_round_trips_without_utf8_assumptions() {
        let mut spec = example();
        spec.arguments.push(b"raw-\xff".to_vec());
        let encoded = spec.encode().expect("encode command");
        assert_eq!(WireCommandSpec::decode(&encoded), Ok(spec));
    }

    #[test]
    fn malformed_commands_fail_closed() {
        let encoded = example().encode().expect("encode command");
        let mut cases = Vec::new();
        cases.push(encoded[..31].to_vec());
        let mut unknown_flag = encoded.clone();
        unknown_flag[3] = 0x80;
        cases.push(unknown_flag);
        let mut impossible_count = encoded.clone();
        impossible_count[20..22].copy_from_slice(&u16::MAX.to_le_bytes());
        cases.push(impossible_count);
        let mut trailing = encoded.clone();
        trailing.push(0);
        cases.push(trailing);
        for case in cases {
            assert!(WireCommandSpec::decode(&case).is_err());
        }
    }

    #[test]
    fn pty_size_is_exact_and_nonzero() {
        let size = WirePtySize {
            rows: 25,
            columns: 100,
            pixel_width: 800,
            pixel_height: 600,
        };
        assert_eq!(
            WirePtySize::decode(&size.encode().expect("encode")),
            Ok(size)
        );
        assert!(WirePtySize::decode(&[0; 8]).is_err());
    }

    #[test]
    fn command_actions_are_correlated_and_canonical() {
        let request = encode_action_request(17, b"input").expect("encode action");
        assert_eq!(decode_action_request(&request), Ok((17, &b"input"[..])));
        assert!(encode_action_request(0, b"input").is_err());

        let result = WireActionResult {
            action_id: 17,
            accepted_bytes: 5,
            errno: 0,
        };
        assert_eq!(
            WireActionResult::decode(&result.encode().expect("encode")),
            Ok(result)
        );
        assert!(
            WireActionResult {
                action_id: 17,
                accepted_bytes: 1,
                errno: 11,
            }
            .encode()
            .is_err()
        );
    }
}
