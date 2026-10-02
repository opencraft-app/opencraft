//! Safe guest-memory contract tests.

use minisandbox_core::memory::{GuestAddress, GuestMemory, MemoryError};
use minisandbox_core::pvm::{PvcsPage, PvmUserFrame};
use minisandbox_pvm_sys::PvmAbi;

#[test]
fn checked_guest_address_arithmetic_rejects_noncanonical_results() {
    let last_page =
        GuestAddress::new(0x0000_7fff_ffff_f000).expect("the last lower-canonical page is valid");

    assert_eq!(
        last_page
            .checked_add(0xfff)
            .expect("the page end is valid")
            .get(),
        0x0000_7fff_ffff_ffff
    );
    assert_eq!(
        last_page.checked_add(0x1000),
        Err(MemoryError::NonCanonical)
    );
    assert_eq!(
        GuestAddress::new(0x0000_8000_0000_0000),
        Err(MemoryError::NonCanonical)
    );
}

#[test]
fn legacy_pvcs_page_initializes_only_the_abi_prefix() {
    let frame = PvmUserFrame {
        rip: 0xc000,
        rsp: 0xdff0,
        rflags: 0x202,
        rcx: 0x1111,
        r11: 0x2222,
        user_gsbase: 0x3333,
    };
    let page = PvcsPage::new(PvmAbi::Legacy, frame);
    let bytes = page.as_bytes();

    assert_eq!(u64::from_le_bytes(bytes[0..8].try_into().unwrap()), 1);
    assert_eq!(u16::from_le_bytes(bytes[64..66].try_into().unwrap()), 0x33);
    assert_eq!(u16::from_le_bytes(bytes[66..68].try_into().unwrap()), 0x2b);
    assert_eq!(
        u64::from_le_bytes(bytes[96..104].try_into().unwrap()),
        frame.rip
    );
    assert_eq!(
        u64::from_le_bytes(bytes[104..112].try_into().unwrap()),
        frame.rsp
    );
    assert_eq!(
        u64::from_le_bytes(bytes[112..120].try_into().unwrap()),
        frame.rcx
    );
    assert_eq!(
        u64::from_le_bytes(bytes[120..128].try_into().unwrap()),
        frame.r11
    );
    assert!(bytes[128..].iter().all(|byte| *byte == 0));
}

#[test]
fn guest_memory_copies_are_bounded_before_indexing() {
    let mut memory = GuestMemory::new(8192);
    let boundary = GuestAddress::new(4094).expect("the test address is canonical");

    memory
        .write(boundary, &[1, 2, 3, 4])
        .expect("a copy crossing an internal page boundary is valid");
    assert_eq!(
        memory
            .read(boundary, 4)
            .expect("the previously written range is readable"),
        &[1, 2, 3, 4]
    );

    let last_byte = GuestAddress::new(8191).expect("the last byte is canonical");
    assert_eq!(
        memory.write(last_byte, &[9, 10]),
        Err(MemoryError::OutOfBounds)
    );
}
