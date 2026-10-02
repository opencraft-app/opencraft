//! Platform-neutral contracts for configuring and observing one PVM run.

use crate::PvmAbi;

/// First dedicated I/O port used by the supervisor event-reporting stub.
///
/// Keeping the event range separate from the `0x80` syscall port ensures that
/// x86 vector zero cannot be misclassified as a guest system call.
pub const PVM_EVENT_PORT_BASE: u16 = 0x100;

/// Last dedicated event-reporting port (x86 vectors 0 through 31).
pub const PVM_EVENT_PORT_END: u16 = PVM_EVENT_PORT_BASE + 0x1f;

/// Dedicated I/O-exit port reserved for minisandbox guest capabilities.
pub const PVM_HYPERCALL_PORT: u16 = 0x81;

/// Current guest-supervisor to host hypercall ABI version.
pub const PVM_HYPERCALL_ABI_VERSION: u8 = 1;

const PVM_HYPERCALL_MAGIC: u32 = 0x4d53_0000;
const PVM_HYPERCALL_MAGIC_MASK: u32 = 0xffff_0000;
const PVM_HYPERCALL_VERSION_MASK: u32 = 0x0000_ff00;
const PVM_HYPERCALL_OPERATION_MASK: u32 = 0x0000_00ff;

/// Guest-to-host command-ring transition notification.
pub const PVM_SERVICE_QUEUE_COMMAND: u64 = 1 << 0;

/// Every queue bit accepted by hypercall ABI version one.
pub const PVM_SERVICE_QUEUE_ALLOWED_MASK: u64 = PVM_SERVICE_QUEUE_COMMAND;

/// Validated, nonempty set of service queues made ready by the guest.
///
/// This value contains no guest pointer, address, descriptor count, or socket
/// identifier. It only schedules bounded draining of host-configured rings.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PvmServiceQueueSet(u64);

impl PvmServiceQueueSet {
    /// Validates a guest-supplied queue-set mask.
    #[must_use]
    pub const fn from_bits(bits: u64) -> Option<Self> {
        if bits == 0 || bits & !PVM_SERVICE_QUEUE_ALLOWED_MASK != 0 {
            None
        } else {
            Some(Self(bits))
        }
    }

    /// Returns the validated queue bits.
    #[must_use]
    pub const fn bits(self) -> u64 {
        self.0
    }
}

/// Capability operations initially exposed to a PVM Linux guest driver.
///
/// This is intentionally not a Linux syscall namespace. Every operation has a
/// bounded, typed host implementation that treats the supervisor as untrusted.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum PvmHypercall {
    /// Writes one user-root buffer to sandbox stdout or stderr.
    ConsoleWrite = 1,
    /// Terminates the complete sandbox with a caller-supplied status.
    Exit = 2,
    /// Publishes a quiescent warm-checkpoint boundary to the runtime.
    CheckpointReady = 3,
    /// Marks the first guest userspace point reached by a restored clone.
    BenchmarkPoint = 4,
    /// Reports buddy-free RAM pages that may return to the sealed template.
    PageReport = 5,
    /// Marks one or more fixed service command rings ready for bounded draining.
    ServiceNotify = 6,
    /// Publishes the next Linux idle deadline and yields the vCPU to the runtime.
    WaitUntil = 7,
}

impl PvmHypercall {
    /// Encodes a self-identifying 32-bit I/O payload.
    #[must_use]
    pub const fn encode(self) -> u32 {
        PVM_HYPERCALL_MAGIC | ((PVM_HYPERCALL_ABI_VERSION as u32) << 8) | self as u32
    }

    /// Validates and decodes one supervisor-provided I/O payload.
    #[must_use]
    pub const fn decode(word: u32) -> Option<Self> {
        if word & PVM_HYPERCALL_MAGIC_MASK != PVM_HYPERCALL_MAGIC
            || word & PVM_HYPERCALL_VERSION_MASK != (PVM_HYPERCALL_ABI_VERSION as u32) << 8
        {
            return None;
        }
        match word & PVM_HYPERCALL_OPERATION_MASK {
            1 => Some(Self::ConsoleWrite),
            2 => Some(Self::Exit),
            3 => Some(Self::CheckpointReady),
            4 => Some(Self::BenchmarkPoint),
            5 => Some(Self::PageReport),
            6 => Some(Self::ServiceNotify),
            7 => Some(Self::WaitUntil),
            _ => None,
        }
    }
}

/// Host-only attribution counters for one PVM machine.
///
/// These counters contain no guest-provided addresses or payloads. They are
/// intended for scheduler A/B tests and are resettable only while the caller
/// has exclusive access to the machine.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct PvmRunStats {
    /// Calls made to `KVM_RUN`.
    pub kvm_runs: u64,
    /// Host-visible `KVM_EXIT_HLT` results.
    pub hlt_exits: u64,
    /// UART port exits serviced inside the machine run loop.
    pub uart_io_exits: u64,
    /// CMOS port exits serviced inside the machine run loop.
    pub cmos_io_exits: u64,
    /// Legacy port-0x80 delay exits discarded inside the machine run loop.
    pub io_delay_exits: u64,
    /// Virtio block MMIO exits serviced inside the machine run loop.
    pub block_mmio_exits: u64,
    /// Valid fixed-width `WAIT_UNTIL` hypercalls decoded from the guest.
    pub wait_until_exits: u64,
    /// First waits used only to arm device wake forwarding without racing IRQs.
    pub wait_until_arms: u64,
    /// Long waits parked outside `KVM_RUN`.
    pub wait_until_parks: u64,
    /// Deadlines too short to justify a host poll operation.
    pub wait_until_short: u64,
    /// Host polls completed because the relative guest deadline elapsed.
    pub wait_deadline_wakes: u64,
    /// Host polls completed because a registered device signaled an IRQ.
    pub wait_device_wakes: u64,
    /// Saturating sum of guest-requested relative nanoseconds.
    pub requested_wait_ns: u64,
}

/// Standard x86 Linux 64-bit boot-protocol entry state.
///
/// Unlike [`PvmBootConfig`], this starts at the kernel's normal 64-bit entry.
/// The PVM-aware kernel detects PVM and installs its own PVCS, event entry, and
/// paravirtual operations during early boot.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PvmLinuxBootConfig {
    /// Physical entry address of the protected-mode kernel plus 512 bytes.
    pub entry_rip: u64,
    /// Physical address of the Linux zero page (`struct boot_params`).
    pub boot_params_gpa: u64,
    /// Identity-mapped bootstrap page-table root.
    pub bootstrap_cr3: u64,
    /// Temporary bootstrap stack pointer.
    pub stack_pointer: u64,
    /// Guest-physical address of the bootstrap GDT.
    pub gdt_base: u64,
    /// Bootstrap GDT byte limit.
    pub gdt_limit: u16,
}

/// Minimal `x86_64` supervisor and PVM control state for user entry.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PvmBootConfig {
    /// Selected PVCS/control-MSR contract.
    pub abi: PvmAbi,
    /// Supervisor page-table root guest-physical address.
    pub supervisor_cr3: u64,
    /// Legacy user page-table root guest-physical address.
    pub user_cr3: u64,
    /// PVCS backing guest-physical address.
    pub pvcs_gpa: u64,
    /// Supervisor instruction containing the synthetic ERETU `SYSCALL`.
    pub retu_rip: u64,
    /// PVM event-entry address.
    pub event_entry: u64,
    /// Legacy synthetic RETS `SYSCALL` address.
    pub legacy_rets_rip: u64,
    /// Supervisor LSTAR syscall entry.
    pub lstar: u64,
    /// Top of the supervisor stack.
    pub supervisor_rsp: u64,
    /// Initial user stack pointer used by the modern ABI.
    pub user_rsp: u64,
    /// Guest virtual address of the GDT.
    pub gdt_base: u64,
    /// GDT byte limit.
    pub gdt_limit: u16,
}

/// Host-visible result of one KVM/PVM run operation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PvmExit {
    /// Bytes transmitted by the minimal guest UART.
    ConsoleWrite {
        /// Bytes written by the guest.
        data: Vec<u8>,
    },
    /// Guest emitted bytes through an x86 OUT instruction.
    IoOut {
        /// Destination I/O port.
        port: u16,
        /// Bytes emitted by the instruction.
        data: Vec<u8>,
    },
    /// Guest made a validated fixed service queue ready.
    ServiceNotify {
        /// Nonempty queue set with every unknown bit rejected.
        queues: PvmServiceQueueSet,
    },
    /// Guest idle code published one relative Linux `NO_HZ` deadline.
    WaitUntil {
        /// Relative nanoseconds until the earliest guest timer event.
        timeout_ns: u64,
    },
    /// Guest requested termination through the bounded exit capability.
    GuestExit {
        /// Validated process-style status in the range 0 through 255.
        status: u8,
    },
    /// PVM delivered one user event through the configured supervisor stub.
    Event {
        /// x86 exception or interrupt vector.
        vector: u8,
        /// x86 event error code supplied by PVM.
        error_code: u32,
        /// Faulting linear address copied from PVCS CR2.
        address: u64,
    },
    /// Guest executed HLT.
    Halted,
    /// KVM reported guest shutdown/triple fault.
    Shutdown,
    /// Guest attempted to modify a host-enforced read-only memory slot.
    ReadOnlyMemoryWrite {
        /// Guest-physical address of the rejected write.
        address: u64,
        /// Bytes the untrusted guest attempted to store.
        data: Vec<u8>,
    },
    /// Host monotonic deadline interrupted `KVM_RUN`.
    TimedOut,
    /// A host-only terminal cancellation interrupted the runner.
    Cancelled,
    /// A run exit not yet handled by the runtime.
    Unexpected {
        /// Debug representation copied before the shared run mapping is reused.
        description: String,
    },
}

/// General-purpose registers needed by host syscall emulation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PvmRegisters {
    /// Return value / syscall number.
    pub rax: u64,
    /// First syscall argument.
    pub rdi: u64,
    /// Second syscall argument.
    pub rsi: u64,
    /// Third syscall argument.
    pub rdx: u64,
    /// Fourth syscall argument.
    pub r10: u64,
    /// Fifth syscall argument.
    pub r8: u64,
    /// Sixth syscall argument.
    pub r9: u64,
}
