//! Contract tests for PVM capability classification.

use minisandbox_pvm_sys::{ProbeError, ProbeObservation, PvmAbi, classify_probe};

fn supported_observation() -> ProbeObservation {
    ProbeObservation {
        kvm_api_version: 12,
        vcpu_mmap_size: 4096,
        has_fsgsbase: true,
        has_pvm_vcpu_struct_msr: true,
        has_legacy_supervisor_rsp_msr: true,
    }
}

#[test]
fn legacy_pvm_is_classified_by_its_control_msr() {
    let capabilities = classify_probe(supported_observation())
        .expect("the installed PVM capability set must be supported");

    assert_eq!(capabilities.abi, PvmAbi::Legacy);
    assert_eq!(capabilities.vcpu_mmap_size, 4096);
}

#[test]
fn incomplete_capability_sets_report_the_exact_gate() {
    let mut observation = supported_observation();
    observation.kvm_api_version = 11;
    assert_eq!(
        classify_probe(observation),
        Err(ProbeError::UnsupportedKvmApi)
    );

    let mut observation = supported_observation();
    observation.vcpu_mmap_size = 0;
    assert_eq!(
        classify_probe(observation),
        Err(ProbeError::InvalidVcpuMmapSize)
    );

    let mut observation = supported_observation();
    observation.has_fsgsbase = false;
    assert_eq!(
        classify_probe(observation),
        Err(ProbeError::MissingFsgsbase)
    );

    let mut observation = supported_observation();
    observation.has_pvm_vcpu_struct_msr = false;
    assert_eq!(classify_probe(observation), Err(ProbeError::UnsupportedPvm));
}
