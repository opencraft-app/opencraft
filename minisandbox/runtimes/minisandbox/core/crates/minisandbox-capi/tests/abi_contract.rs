//! Contract tests for the stable minisandbox C ABI.

use core::mem::{offset_of, size_of};

use minisandbox_capi::{
    ABI_VERSION_MAJOR, ABI_VERSION_MINOR, ByteSlice, GuestFile, Handle, RuntimeOptions, Status,
    abi_version,
};

#[test]
fn abi_version_statuses_and_structure_prefix_are_stable() {
    assert_eq!(ABI_VERSION_MAJOR, 1);
    assert_eq!(ABI_VERSION_MINOR, 4);
    assert_eq!(abi_version(), (1 << 16) | 4);
    assert_eq!(size_of::<Handle>(), size_of::<u64>());
    assert_eq!(size_of::<GuestFile>(), 2 * size_of::<ByteSlice>());
    assert_eq!(offset_of!(GuestFile, path), 0);
    assert_eq!(offset_of!(GuestFile, contents), size_of::<ByteSlice>());

    assert_eq!(Status::Ok as u32, 0);
    assert_eq!(Status::InvalidArgument as u32, 1);
    assert_eq!(Status::UnsupportedPvm as u32, 2);
    assert_eq!(Status::InvalidHandle as u32, 3);
    assert_eq!(Status::WrongHandleKind as u32, 4);
    assert_eq!(Status::Busy as u32, 5);
    assert_eq!(Status::GuestFault as u32, 6);
    assert_eq!(Status::Timeout as u32, 7);
    assert_eq!(Status::HostError as u32, 8);
    assert_eq!(Status::Internal as u32, 255);

    assert_eq!(offset_of!(RuntimeOptions, struct_size), 0);
    assert_eq!(offset_of!(RuntimeOptions, abi_version), 4);
    let options = RuntimeOptions::default();
    assert_eq!(options.struct_size as usize, size_of::<RuntimeOptions>());
    assert_eq!(options.abi_version, abi_version());
}
