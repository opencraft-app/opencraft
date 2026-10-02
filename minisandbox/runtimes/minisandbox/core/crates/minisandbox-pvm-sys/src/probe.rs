use minisandbox_macros::contract_enum;

contract_enum! {
    /// Supported PVM control-structure contracts.
    #[repr(u32)]
    pub enum PvmAbi {
        /// Published vector-owned PVCS contract.
        Modern = 1,
        /// Installed 6.7-era dual-CR3 contract.
        Legacy = 2,
    }
}

contract_enum! {
    /// Capability classification failures.
    #[repr(u32)]
    pub enum ProbeError {
        /// `KVM_GET_API_VERSION` did not return the supported API.
        UnsupportedKvmApi = 1,
        /// `KVM_GET_VCPU_MMAP_SIZE` returned an unusable value.
        InvalidVcpuMmapSize = 2,
        /// Guest CPUID does not expose FSGSBASE.
        MissingFsgsbase = 3,
        /// The PVM virtual CPU structure MSR is unavailable.
        UnsupportedPvm = 4,
    }
}

/// Raw observations collected from KVM and a created vCPU.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProbeObservation {
    /// Value returned by `KVM_GET_API_VERSION`.
    pub kvm_api_version: i32,
    /// Value returned by `KVM_GET_VCPU_MMAP_SIZE`.
    pub vcpu_mmap_size: usize,
    /// Whether guest CPUID exposes FSGSBASE.
    pub has_fsgsbase: bool,
    /// Whether `MSR_PVM_VCPU_STRUCT` can be read.
    pub has_pvm_vcpu_struct_msr: bool,
    /// Whether the legacy supervisor-stack MSR can be read.
    pub has_legacy_supervisor_rsp_msr: bool,
}

/// Validated PVM capabilities used to configure later runtime objects.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PvmCapabilities {
    /// Selected PVCS/control-MSR contract.
    pub abi: PvmAbi,
    /// KVM API version observed during the probe.
    pub kvm_api_version: i32,
    /// Size of the shared `kvm_run` mapping.
    pub vcpu_mmap_size: usize,
    /// Whether guest CPUID exposes FSGSBASE.
    pub has_fsgsbase: bool,
}

/// Classifies a collected capability observation without consulting module names.
///
/// # Errors
///
/// Returns the first [`ProbeError`] whose required KVM/PVM capability is absent.
pub fn classify_probe(observation: ProbeObservation) -> Result<PvmCapabilities, ProbeError> {
    if observation.kvm_api_version != 12 {
        return Err(ProbeError::UnsupportedKvmApi);
    }
    if observation.vcpu_mmap_size == 0 {
        return Err(ProbeError::InvalidVcpuMmapSize);
    }
    if !observation.has_fsgsbase {
        return Err(ProbeError::MissingFsgsbase);
    }
    if !observation.has_pvm_vcpu_struct_msr {
        return Err(ProbeError::UnsupportedPvm);
    }

    Ok(PvmCapabilities {
        abi: if observation.has_legacy_supervisor_rsp_msr {
            PvmAbi::Legacy
        } else {
            PvmAbi::Modern
        },
        kvm_api_version: observation.kvm_api_version,
        vcpu_mmap_size: observation.vcpu_mmap_size,
        has_fsgsbase: observation.has_fsgsbase,
    })
}
