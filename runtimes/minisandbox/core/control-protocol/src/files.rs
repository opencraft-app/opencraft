//! Strict codecs shared by the untrusted guest and trusted host file endpoints.

use crate::{MAX_PATH_BYTES, WireError};

const FILE_INFO_FIXED_SIZE: usize = 32;

/// Portable file type returned by the guest agent.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum FileKind {
    /// Regular file.
    File = 1,
    /// Directory.
    Directory = 2,
    /// Symbolic link; the metadata record includes its raw target.
    Symlink = 3,
    /// Another Unix file type.
    Other = 4,
}

impl TryFrom<u8> for FileKind {
    type Error = WireError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::File),
            2 => Ok(Self::Directory),
            3 => Ok(Self::Symlink),
            4 => Ok(Self::Other),
            _ => Err(WireError::NonCanonical),
        }
    }
}

/// Validated metadata payload. Names and symlink targets retain Unix bytes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WireFileInfo {
    /// File type without following symlinks.
    pub kind: FileKind,
    /// Linux `st_mode`, including type and permission bits.
    pub mode: u32,
    /// Logical byte size.
    pub size: u64,
    /// Whole seconds since the Unix epoch.
    pub modified_sec: i64,
    /// Fractional nanoseconds in 0..1,000,000,000.
    pub modified_nsec: u32,
    /// Requested path for stat, or basename for a directory entry.
    pub name: Vec<u8>,
    /// Raw symlink target, present only for [`FileKind::Symlink`].
    pub symlink_target: Option<Vec<u8>>,
}

impl WireFileInfo {
    /// Encodes a canonical bounded metadata record.
    ///
    /// # Errors
    ///
    /// Rejects invalid lengths, mode bits, timestamps, NUL bytes, and target/type pairs.
    pub fn encode(&self) -> Result<Vec<u8>, WireError> {
        validate_info(self)?;
        let target = self.symlink_target.as_deref().unwrap_or_default();
        let name_len = u16::try_from(self.name.len()).map_err(|_| WireError::PayloadTooLarge)?;
        let target_len = u16::try_from(target.len()).map_err(|_| WireError::PayloadTooLarge)?;
        let mut bytes = vec![0_u8; FILE_INFO_FIXED_SIZE + self.name.len() + target.len()];
        bytes[0] = self.kind as u8;
        bytes[4..8].copy_from_slice(&self.mode.to_le_bytes());
        bytes[8..16].copy_from_slice(&self.size.to_le_bytes());
        bytes[16..24].copy_from_slice(&self.modified_sec.to_le_bytes());
        bytes[24..28].copy_from_slice(&self.modified_nsec.to_le_bytes());
        bytes[28..30].copy_from_slice(&name_len.to_le_bytes());
        bytes[30..32].copy_from_slice(&target_len.to_le_bytes());
        bytes[32..32 + self.name.len()].copy_from_slice(&self.name);
        bytes[32 + self.name.len()..].copy_from_slice(target);
        Ok(bytes)
    }

    /// Decodes and validates a metadata record from an untrusted peer.
    ///
    /// # Errors
    ///
    /// Rejects truncated, oversized, reserved, or otherwise noncanonical records.
    pub fn decode(bytes: &[u8]) -> Result<Self, WireError> {
        if bytes.len() < FILE_INFO_FIXED_SIZE || bytes[1..4] != [0, 0, 0] {
            return Err(WireError::NonCanonical);
        }
        let name_len = usize::from(u16::from_le_bytes([bytes[28], bytes[29]]));
        let target_len = usize::from(u16::from_le_bytes([bytes[30], bytes[31]]));
        let expected = FILE_INFO_FIXED_SIZE
            .checked_add(name_len)
            .and_then(|length| length.checked_add(target_len))
            .ok_or(WireError::PayloadTooLarge)?;
        if bytes.len() != expected {
            return Err(WireError::NonCanonical);
        }
        let info = Self {
            kind: FileKind::try_from(bytes[0])?,
            mode: read_u32(bytes, 4),
            size: read_u64(bytes, 8),
            modified_sec: read_i64(bytes, 16),
            modified_nsec: read_u32(bytes, 24),
            name: bytes[32..32 + name_len].to_vec(),
            symlink_target: (target_len != 0).then(|| bytes[32 + name_len..].to_vec()),
        };
        validate_info(&info)?;
        Ok(info)
    }
}

/// Validates one raw absolute guest path.
///
/// # Errors
///
/// Rejects empty, relative, NUL-containing, or overlong paths.
pub fn validate_path(path: &[u8]) -> Result<(), WireError> {
    if path.is_empty() || path.len() > MAX_PATH_BYTES || path[0] != b'/' || path.contains(&0) {
        Err(WireError::NonCanonical)
    } else {
        Ok(())
    }
}

/// Encodes two absolute paths into one canonical rename payload.
///
/// # Errors
///
/// Rejects either invalid path.
pub fn encode_path_pair(first: &[u8], second: &[u8]) -> Result<Vec<u8>, WireError> {
    validate_path(first)?;
    validate_path(second)?;
    let first_len = u32::try_from(first.len()).map_err(|_| WireError::PayloadTooLarge)?;
    let mut payload = Vec::with_capacity(4 + first.len() + second.len());
    payload.extend_from_slice(&first_len.to_le_bytes());
    payload.extend_from_slice(first);
    payload.extend_from_slice(second);
    Ok(payload)
}

/// Decodes two absolute paths from an untrusted rename payload.
///
/// # Errors
///
/// Rejects truncation, trailing ambiguity, or either invalid path.
pub fn decode_path_pair(payload: &[u8]) -> Result<(&[u8], &[u8]), WireError> {
    let length = payload
        .get(..4)
        .ok_or(WireError::NonCanonical)?
        .try_into()
        .map(u32::from_le_bytes)
        .map_err(|_| WireError::NonCanonical)?;
    let split = 4_usize
        .checked_add(usize::try_from(length).map_err(|_| WireError::PayloadTooLarge)?)
        .ok_or(WireError::PayloadTooLarge)?;
    if split >= payload.len() {
        return Err(WireError::NonCanonical);
    }
    let first = payload.get(4..split).ok_or(WireError::NonCanonical)?;
    let second = payload.get(split..).ok_or(WireError::NonCanonical)?;
    validate_path(first)?;
    validate_path(second)?;
    Ok((first, second))
}

fn validate_info(info: &WireFileInfo) -> Result<(), WireError> {
    if info.name.is_empty()
        || info.name.len() > MAX_PATH_BYTES
        || info.name.contains(&0)
        || info.mode > 0o177_777
        || info.modified_nsec >= 1_000_000_000
    {
        return Err(WireError::NonCanonical);
    }
    match (info.kind, info.symlink_target.as_deref()) {
        (FileKind::Symlink, Some(target))
            if !target.is_empty() && target.len() <= MAX_PATH_BYTES && !target.contains(&0) =>
        {
            Ok(())
        }
        (FileKind::Symlink, _) | (_, Some(_)) => Err(WireError::NonCanonical),
        (_, None) => Ok(()),
    }
}

fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("checked range"))
}

fn read_u64(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(bytes[offset..offset + 8].try_into().expect("checked range"))
}

fn read_i64(bytes: &[u8], offset: usize) -> i64 {
    i64::from_le_bytes(bytes[offset..offset + 8].try_into().expect("checked range"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_round_trips_raw_unix_bytes() {
        let info = WireFileInfo {
            kind: FileKind::Symlink,
            mode: 0o120_777,
            size: 9,
            modified_sec: -1,
            modified_nsec: 999_999_999,
            name: b"bad-utf8-\xff".to_vec(),
            symlink_target: Some(b"../target".to_vec()),
        };
        assert_eq!(
            WireFileInfo::decode(&info.encode().expect("encode")),
            Ok(info)
        );
    }

    #[test]
    fn hostile_metadata_is_rejected() {
        let regular = WireFileInfo {
            kind: FileKind::File,
            mode: 0o100_644,
            size: 3,
            modified_sec: 1,
            modified_nsec: 2,
            name: b"name".to_vec(),
            symlink_target: None,
        }
        .encode()
        .expect("encode");
        let mut cases = Vec::new();
        cases.push(regular[..31].to_vec());
        let mut reserved = regular.clone();
        reserved[1] = 1;
        cases.push(reserved);
        let mut unknown_kind = regular.clone();
        unknown_kind[0] = 99;
        cases.push(unknown_kind);
        let mut bad_nsec = regular.clone();
        bad_nsec[24..28].copy_from_slice(&1_000_000_000_u32.to_le_bytes());
        cases.push(bad_nsec);
        let mut wrong_length = regular.clone();
        wrong_length[28..30].copy_from_slice(&8_u16.to_le_bytes());
        cases.push(wrong_length);
        for case in cases {
            assert_eq!(WireFileInfo::decode(&case), Err(WireError::NonCanonical));
        }
    }

    #[test]
    fn path_pair_is_strict() {
        let payload = encode_path_pair(b"/from", b"/to").expect("encode");
        assert_eq!(decode_path_pair(&payload), Ok((&b"/from"[..], &b"/to"[..])));
        assert_eq!(
            encode_path_pair(b"relative", b"/to"),
            Err(WireError::NonCanonical)
        );
        let mut truncated = payload;
        truncated.truncate(8);
        assert_eq!(decode_path_pair(&truncated), Err(WireError::NonCanonical));
    }
}
