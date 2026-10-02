//! Live supervisor-to-user PVM transition conformance.

#![cfg(all(target_os = "linux", target_arch = "x86_64"))]

use std::{
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

use minisandbox_core::pvm::{IsolationAccess, IsolationTarget, PvmUserImage};
use minisandbox_pvm_sys::{PvmDevice, PvmExit, PvmMachine};

const TRANSITION_MAGIC: u32 = 0x5056_4d51;
const FAULT_MAGIC: u32 = 0x4552_5221;
const USER_CODE_GPA: u64 = 0xc000;

fn run_image(device: &PvmDevice, image: &PvmUserImage) -> PvmExit {
    let mut machine: PvmMachine = device
        .create_machine(image.memory().len())
        .expect("the PVM machine and memory slot are creatable");
    machine
        .write_memory(0, image.memory())
        .expect("the checked image fits in the registered memslot");
    machine
        .configure_user_entry(image.boot_config())
        .expect("the PVM user-entry control state is valid");
    machine.run_once().expect("the PVM vCPU run succeeds")
}

#[test]
fn eretu_enters_user_mode_before_the_lstar_exit_stub_runs() {
    let device = PvmDevice::open().expect("the designated host exposes /dev/kvm");
    let capabilities = device
        .capabilities()
        .expect("the designated host exposes the PVM contract");
    let image = PvmUserImage::transition_probe(capabilities.abi)
        .expect("the minimal isolated PVM image is valid");
    assert_eq!(
        run_image(&device, &image),
        PvmExit::IoOut {
            port: 0xe9,
            data: TRANSITION_MAGIC.to_le_bytes().to_vec(),
        }
    );
}

#[test]
fn user_accesses_to_runtime_internal_pages_fault_before_syscall() {
    let device = PvmDevice::open().expect("the designated host exposes /dev/kvm");
    let abi = device
        .capabilities()
        .expect("the designated host exposes the PVM contract")
        .abi;

    for (target, access) in [
        (IsolationTarget::SupervisorCode, IsolationAccess::Read),
        (IsolationTarget::Pvcs, IsolationAccess::Read),
        (IsolationTarget::PageTables, IsolationAccess::Read),
        (IsolationTarget::Pvcs, IsolationAccess::Write),
    ] {
        let image = PvmUserImage::isolation_probe(abi, target, access)
            .expect("the isolated PVM image is valid");
        assert_eq!(
            run_image(&device, &image),
            PvmExit::IoOut {
                port: 0xe9,
                data: FAULT_MAGIC.to_le_bytes().to_vec(),
            },
            "{access:?} of {target:?} did not fault through the PVM event path"
        );
    }
}

#[test]
fn host_cancellation_preempts_an_in_flight_compute_vcpu() {
    let device = PvmDevice::open().expect("the designated host exposes /dev/kvm");
    let abi = device
        .capabilities()
        .expect("the designated host exposes the PVM contract")
        .abi;
    let image = PvmUserImage::transition_probe(abi).expect("the transition image is valid");
    let mut machine = device
        .create_machine(image.memory().len())
        .expect("the PVM machine is creatable");
    machine
        .write_memory(0, image.memory())
        .expect("the transition image fits guest RAM");
    machine
        .write_memory(USER_CODE_GPA, &[0xeb, 0xfe])
        .expect("the user probe can be replaced with jmp $ before execution");
    machine
        .configure_user_entry(image.boot_config())
        .expect("the PVM user-entry state is valid");

    let canceller = machine.run_canceller();
    let (ready_tx, ready_rx) = mpsc::sync_channel(0);
    let runner = thread::spawn(move || {
        let mut run = machine
            .start_timed_run(Duration::from_secs(10))
            .expect("the long product-style run can be armed");
        ready_tx
            .send(())
            .expect("the control thread is waiting for runner registration");
        run.run_once().expect("cancellation is a typed PVM exit")
    });
    ready_rx
        .recv()
        .expect("the runner registers before cancellation");
    thread::sleep(Duration::from_millis(20));

    let started = Instant::now();
    assert!(canceller.cancel().expect("the first cancellation succeeds"));
    assert_eq!(
        runner.join().expect("the PVM runner does not panic"),
        PvmExit::Cancelled
    );
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "PVM cancellation exceeded the one-second wall-clock gate"
    );
    assert!(!canceller.cancel().expect("cancellation is idempotent"));
}
