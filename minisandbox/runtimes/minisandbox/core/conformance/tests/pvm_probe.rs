//! Live capability checks for the designated `x86_64` PVM host.

#![cfg(all(target_os = "linux", target_arch = "x86_64"))]

use minisandbox_pvm_sys::{PvmAbi, PvmDevice};
use std::sync::Mutex;

static LIVE_PVM_TEST: Mutex<()> = Mutex::new(());

fn open_descriptor_count() -> usize {
    std::fs::read_dir("/proc/self/fd")
        .expect("the Linux process descriptor directory must be readable")
        .count()
}

#[test]
fn designated_host_exposes_the_legacy_pvm_contract() {
    let _live_test = LIVE_PVM_TEST
        .lock()
        .expect("the live PVM test lock is valid");
    let device = PvmDevice::open().expect("/dev/kvm must expose a usable PVM provider");
    let capabilities = device
        .capabilities()
        .expect("the live KVM/PVM capability probe must pass");

    assert_eq!(capabilities.abi, PvmAbi::Legacy);
    assert_eq!(capabilities.kvm_api_version, 12);
    assert!(capabilities.vcpu_mmap_size >= 4096);
    assert!(capabilities.has_fsgsbase);
}

#[test]
fn pvm_vm_and_vcpu_ownership_close_descriptors() {
    let _live_test = LIVE_PVM_TEST
        .lock()
        .expect("the live PVM test lock is valid");
    let device = PvmDevice::open().expect("/dev/kvm must expose a usable PVM provider");
    let baseline = open_descriptor_count();

    for id in 0..8 {
        let vm = device.create_vm().expect("PVM VM creation must succeed");
        let vcpu = vm.create_vcpu(id).expect("PVM vCPU creation must succeed");
        assert_eq!(vcpu.id(), id);
    }

    assert_eq!(open_descriptor_count(), baseline);
}
