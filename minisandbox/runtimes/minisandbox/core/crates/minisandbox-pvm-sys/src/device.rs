//! Safe, generic-KVM capability discovery for the PVM provider.

use std::{error::Error, fmt, sync::Arc};

use kvm_bindings::{KVM_MAX_CPUID_ENTRIES, Msrs, kvm_msr_entry};
use kvm_ioctls::{Kvm, VcpuFd, VmFd};

use crate::{
    MSR_SUPERVISOR_RSP, MSR_VCPU_STRUCT, ProbeError, ProbeObservation, PvmCapabilities,
    classify_probe,
};

/// An opened generic KVM system device used to discover PVM support.
pub struct PvmDevice {
    pub(crate) kvm: Kvm,
    pub(crate) msr_indices: Arc<[u32]>,
}

/// An owned PVM virtual machine descriptor.
pub struct PvmVm {
    vm: VmFd,
}

/// An owned PVM virtual CPU descriptor.
pub struct PvmVcpu {
    vcpu: VcpuFd,
    id: u64,
}

trait ProbeIo {
    type Vm;
    type Vcpu;

    fn api_version(&self) -> i32;
    fn vcpu_mmap_size(&self) -> Result<usize, PvmDeviceError>;
    fn has_fsgsbase(&self) -> Result<bool, PvmDeviceError>;
    fn create_vm(&self) -> Result<Self::Vm, PvmDeviceError>;
    fn create_vcpu(&self, vm: &Self::Vm) -> Result<Self::Vcpu, PvmDeviceError>;
    fn read_msr_count(&self, vcpu: &Self::Vcpu, index: u32) -> Result<usize, PvmDeviceError>;
}

/// Failure to open KVM or validate the PVM capability contract.
#[derive(Debug)]
pub enum PvmDeviceError {
    /// A generic KVM operation failed.
    Kvm {
        /// Operation being attempted.
        operation: &'static str,
        /// Provider error, retained without leaking an external error type.
        message: String,
    },
    /// Construction of a variable-sized KVM ABI buffer failed.
    AbiBuffer {
        /// Provider error, retained without leaking an external error type.
        message: String,
    },
    /// Host memory allocation, registration, or access failed.
    Memory {
        /// Operation being attempted.
        operation: &'static str,
        /// Failure details.
        message: String,
    },
    /// Collected observations do not satisfy the PVM contract.
    Probe(ProbeError),
}

impl fmt::Display for PvmDeviceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Kvm { operation, message } => {
                write!(formatter, "KVM operation {operation} failed: {message}")
            }
            Self::AbiBuffer { message } => {
                write!(formatter, "failed to construct KVM ABI buffer: {message}")
            }
            Self::Memory { operation, message } => {
                write!(
                    formatter,
                    "guest memory operation {operation} failed: {message}"
                )
            }
            Self::Probe(error) => write!(formatter, "PVM capability probe failed: {error:?}"),
        }
    }
}

impl Error for PvmDeviceError {}

impl PvmDevice {
    /// Opens `/dev/kvm` through the generic KVM userspace API.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError::Kvm`] when the KVM device cannot be opened.
    pub fn open() -> Result<Self, PvmDeviceError> {
        let kvm = Kvm::new().map_err(|error| kvm_error("open /dev/kvm", error))?;
        let msr_indices: Arc<[u32]> = kvm
            .get_msr_index_list()
            .map_err(|error| kvm_error("get supported MSR list", error))?
            .as_slice()
            .into();
        Ok(Self { kvm, msr_indices })
    }

    /// Creates an owned PVM virtual machine through the active KVM provider.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError::Kvm`] when VM construction fails.
    pub fn create_vm(&self) -> Result<PvmVm, PvmDeviceError> {
        self.kvm
            .create_vm()
            .map(|vm| PvmVm { vm })
            .map_err(|error| kvm_error("create PVM VM", error))
    }

    /// Collects and validates the capabilities required by the PVM runtime.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError`] if a generic KVM operation or ABI-buffer
    /// construction fails, or if the observed provider is not usable as PVM.
    pub fn capabilities(&self) -> Result<PvmCapabilities, PvmDeviceError> {
        probe_capabilities(self)
    }
}

impl ProbeIo for PvmDevice {
    type Vcpu = PvmVcpu;
    type Vm = PvmVm;

    fn api_version(&self) -> i32 {
        self.kvm.get_api_version()
    }

    fn vcpu_mmap_size(&self) -> Result<usize, PvmDeviceError> {
        self.kvm
            .get_vcpu_mmap_size()
            .map_err(|error| kvm_error("get vCPU mmap size", error))
    }

    fn has_fsgsbase(&self) -> Result<bool, PvmDeviceError> {
        let cpuid = self
            .kvm
            .get_supported_cpuid(KVM_MAX_CPUID_ENTRIES)
            .map_err(|error| kvm_error("get supported CPUID", error))?;
        Ok(cpuid
            .as_slice()
            .iter()
            .any(|entry| entry.function == 7 && entry.index == 0 && entry.ebx & 1 != 0))
    }

    fn create_vm(&self) -> Result<Self::Vm, PvmDeviceError> {
        PvmDevice::create_vm(self)
    }

    fn create_vcpu(&self, vm: &Self::Vm) -> Result<Self::Vcpu, PvmDeviceError> {
        vm.create_vcpu(0)
    }

    fn read_msr_count(&self, vcpu: &Self::Vcpu, index: u32) -> Result<usize, PvmDeviceError> {
        read_msr_count(&vcpu.vcpu, index)
    }
}

fn probe_capabilities<Provider: ProbeIo>(
    provider: &Provider,
) -> Result<PvmCapabilities, PvmDeviceError> {
    let kvm_api_version = provider.api_version();
    let vcpu_mmap_size = provider.vcpu_mmap_size()?;
    let has_fsgsbase = provider.has_fsgsbase()?;

    let vm = provider.create_vm()?;
    let vcpu = provider.create_vcpu(&vm)?;
    let pvm_msr_count = provider.read_msr_count(&vcpu, MSR_VCPU_STRUCT)?;
    let legacy_msr_count = provider.read_msr_count(&vcpu, MSR_SUPERVISOR_RSP)?;

    classify_probe(ProbeObservation {
        kvm_api_version,
        vcpu_mmap_size,
        has_fsgsbase,
        has_pvm_vcpu_struct_msr: pvm_msr_count == 1,
        has_legacy_supervisor_rsp_msr: legacy_msr_count == 1,
    })
    .map_err(PvmDeviceError::Probe)
}

impl PvmVm {
    /// Creates an owned vCPU belonging to this PVM VM.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError::Kvm`] when vCPU construction fails.
    pub fn create_vcpu(&self, id: u64) -> Result<PvmVcpu, PvmDeviceError> {
        self.vm
            .create_vcpu(id)
            .map(|vcpu| PvmVcpu { vcpu, id })
            .map_err(|error| kvm_error("create PVM vCPU", error))
    }
}

impl PvmVcpu {
    /// Returns the caller-assigned KVM vCPU identifier.
    #[must_use]
    pub const fn id(&self) -> u64 {
        self.id
    }
}

fn read_msr_count(vcpu: &VcpuFd, index: u32) -> Result<usize, PvmDeviceError> {
    let mut msrs = Msrs::from_entries(&[kvm_msr_entry {
        index,
        ..Default::default()
    }])
    .map_err(|error| PvmDeviceError::AbiBuffer {
        message: error.to_string(),
    })?;

    vcpu.get_msrs(&mut msrs)
        .map_err(|error| kvm_error("read probe MSR", error))
}

fn kvm_error(operation: &'static str, error: impl fmt::Display) -> PvmDeviceError {
    PvmDeviceError::Kvm {
        operation,
        message: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use super::{ProbeIo, PvmDeviceError, probe_capabilities};
    use crate::{MSR_SUPERVISOR_RSP, MSR_VCPU_STRUCT, ProbeError};

    struct DropMarker(Arc<AtomicUsize>);

    impl Drop for DropMarker {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    struct ScriptedVm {
        _drop_marker: DropMarker,
    }
    struct ScriptedVcpu {
        _drop_marker: DropMarker,
    }

    struct ScriptedProbe {
        drops: Arc<AtomicUsize>,
        pvm_msr_count: usize,
        fail_after_vcpu: bool,
    }

    impl ProbeIo for ScriptedProbe {
        type Vcpu = ScriptedVcpu;
        type Vm = ScriptedVm;

        fn api_version(&self) -> i32 {
            12
        }

        fn vcpu_mmap_size(&self) -> Result<usize, PvmDeviceError> {
            Ok(4096)
        }

        fn has_fsgsbase(&self) -> Result<bool, PvmDeviceError> {
            Ok(true)
        }

        fn create_vm(&self) -> Result<Self::Vm, PvmDeviceError> {
            Ok(ScriptedVm {
                _drop_marker: DropMarker(Arc::clone(&self.drops)),
            })
        }

        fn create_vcpu(&self, _vm: &Self::Vm) -> Result<Self::Vcpu, PvmDeviceError> {
            Ok(ScriptedVcpu {
                _drop_marker: DropMarker(Arc::clone(&self.drops)),
            })
        }

        fn read_msr_count(&self, _vcpu: &Self::Vcpu, index: u32) -> Result<usize, PvmDeviceError> {
            if self.fail_after_vcpu {
                return Err(PvmDeviceError::Kvm {
                    operation: "scripted MSR read",
                    message: "injected failure".to_owned(),
                });
            }
            Ok(if index == MSR_VCPU_STRUCT {
                self.pvm_msr_count
            } else {
                usize::from(index == MSR_SUPERVISOR_RSP)
            })
        }
    }

    #[test]
    fn short_pvm_msr_read_is_rejected_and_owned_state_is_dropped() {
        let drops = Arc::new(AtomicUsize::new(0));
        let backend = ScriptedProbe {
            drops: Arc::clone(&drops),
            pvm_msr_count: 0,
            fail_after_vcpu: false,
        };

        assert!(matches!(
            probe_capabilities(&backend),
            Err(PvmDeviceError::Probe(ProbeError::UnsupportedPvm))
        ));
        assert_eq!(drops.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn ioctl_failure_after_vcpu_creation_drops_partial_state() {
        let drops = Arc::new(AtomicUsize::new(0));
        let backend = ScriptedProbe {
            drops: Arc::clone(&drops),
            pvm_msr_count: 1,
            fail_after_vcpu: true,
        };

        assert!(matches!(
            probe_capabilities(&backend),
            Err(PvmDeviceError::Kvm { .. })
        ));
        assert_eq!(drops.load(Ordering::SeqCst), 2);
    }
}
