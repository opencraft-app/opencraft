//! Small fail-closed parser for the only UDP payload the broker accepts.

/// Maximum accepted DNS query size. This bounds both parsing and amplification input.
pub const QUERY_MAX: usize = 512;
/// Maximum response that fits after the authenticated endpoint prefix.
pub const RESPONSE_MAX: usize = crate::layout::SLOT_SIZE - crate::wire::ENDPOINT_SIZE;

/// Validates one ordinary IN/A or IN/AAAA query and returns its transaction ID.
///
/// One optional EDNS OPT record is accepted. Its payload may be empty or
/// contain one bounded DNS COOKIE option, as emitted by `dig`. Compression
/// pointers in the question and every other additional-record shape are
/// rejected.
pub(crate) fn validate_query(bytes: &[u8]) -> Result<u16, i32> {
    if bytes.len() < 17 || bytes.len() > QUERY_MAX {
        return Err(libc::EMSGSIZE);
    }
    let flags = read_u16(bytes, 2)?;
    let questions = read_u16(bytes, 4)?;
    let answers = read_u16(bytes, 6)?;
    let authorities = read_u16(bytes, 8)?;
    let additionals = read_u16(bytes, 10)?;
    if flags & !(0x0100 | 0x0020 | 0x0010) != 0
        || questions != 1
        || answers != 0
        || authorities != 0
        || additionals > 1
    {
        return Err(libc::EINVAL);
    }

    let mut cursor = skip_uncompressed_name(bytes, 12)?;
    let query_type = read_u16(bytes, cursor)?;
    let query_class = read_u16(bytes, cursor + 2)?;
    cursor = cursor.checked_add(4).ok_or(libc::EINVAL)?;
    if !matches!(query_type, 1 | 28) || query_class != 1 {
        return Err(libc::EACCES);
    }
    if additionals == 1 {
        if bytes.get(cursor) != Some(&0) {
            return Err(libc::EINVAL);
        }
        cursor += 1;
        if read_u16(bytes, cursor)? != 41 {
            return Err(libc::EINVAL);
        }
        let data_length = usize::from(read_u16(bytes, cursor + 8)?);
        let data_start = cursor.checked_add(10).ok_or(libc::EINVAL)?;
        let data_end = data_start.checked_add(data_length).ok_or(libc::EINVAL)?;
        validate_edns_data(bytes.get(data_start..data_end).ok_or(libc::EINVAL)?)?;
        cursor = data_end;
    }
    if cursor != bytes.len() {
        return Err(libc::EINVAL);
    }
    read_u16(bytes, 0)
}

fn validate_edns_data(bytes: &[u8]) -> Result<(), i32> {
    if bytes.is_empty() {
        return Ok(());
    }
    let option = read_u16(bytes, 0)?;
    let length = usize::from(read_u16(bytes, 2)?);
    if option != 10 || length + 4 != bytes.len() {
        return Err(libc::EINVAL);
    }
    // RFC 7873: an eight-byte client cookie, optionally followed by an
    // eight-to-32-byte server cookie.
    if length != 8 && !(16..=40).contains(&length) {
        return Err(libc::EINVAL);
    }
    Ok(())
}

/// Checks the bounded header fields required before a DNS response is published.
pub(crate) fn validate_response(bytes: &[u8]) -> Result<u16, i32> {
    if bytes.len() < 12 || bytes.len() > RESPONSE_MAX {
        return Err(libc::EMSGSIZE);
    }
    let flags = read_u16(bytes, 2)?;
    if flags & 0x8000 == 0 || flags & 0x7800 != 0 || read_u16(bytes, 4)? != 1 {
        return Err(libc::EPROTO);
    }
    read_u16(bytes, 0)
}

fn skip_uncompressed_name(bytes: &[u8], mut cursor: usize) -> Result<usize, i32> {
    let mut wire_length = 0_usize;
    loop {
        let length = usize::from(*bytes.get(cursor).ok_or(libc::EINVAL)?);
        cursor += 1;
        if length == 0 {
            return Ok(cursor);
        }
        if length > 63 {
            return Err(libc::EINVAL);
        }
        wire_length = wire_length
            .checked_add(length + 1)
            .filter(|length| *length <= 255)
            .ok_or(libc::EINVAL)?;
        cursor = cursor.checked_add(length).ok_or(libc::EINVAL)?;
        if cursor > bytes.len() {
            return Err(libc::EINVAL);
        }
    }
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16, i32> {
    let value = bytes.get(offset..offset + 2).ok_or(libc::EINVAL)?;
    Ok(u16::from_be_bytes([value[0], value[1]]))
}

#[cfg(test)]
mod tests {
    use super::{validate_query, validate_response};

    fn query() -> Vec<u8> {
        let mut bytes = vec![0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0];
        bytes.extend_from_slice(b"\x07example\x03com\0\0\x01\0\x01");
        bytes
    }

    #[test]
    fn accepts_one_bounded_address_query_and_matching_response_shape() {
        assert_eq!(validate_query(&query()), Ok(0x1234));
        let response = [0x12, 0x34, 0x81, 0x80, 0, 1, 0, 0, 0, 0, 0, 0];
        assert_eq!(validate_response(&response), Ok(0x1234));
    }

    #[test]
    fn accepts_the_bounded_edns_cookie_emitted_by_dig() {
        let mut query = query();
        query[11] = 1;
        query.extend_from_slice(&[
            0, 0, 41, 4, 0xd0, 0, 0, 0, 0, 0, 12, 0, 10, 0, 8, 1, 2, 3, 4, 5, 6, 7, 8,
        ]);
        assert_eq!(validate_query(&query), Ok(0x1234));

        query.push(0);
        assert_eq!(validate_query(&query), Err(libc::EINVAL));
    }

    #[test]
    fn rejects_response_many_question_and_unsupported_type_shapes() {
        let mut malformed = query();
        malformed[2] |= 0x80;
        assert_eq!(validate_query(&malformed), Err(libc::EINVAL));
        let mut many_questions = query();
        many_questions[5] = 2;
        assert_eq!(validate_query(&many_questions), Err(libc::EINVAL));
        let mut unsupported_type = query();
        let end = unsupported_type.len();
        unsupported_type[end - 4..end - 2].copy_from_slice(&15_u16.to_be_bytes());
        assert_eq!(validate_query(&unsupported_type), Err(libc::EACCES));
    }
}
