//! Integration tests for declarative contract enum generation.

use minisandbox_macros::contract_enum;

contract_enum! {
    /// Probe result used by this macro integration test.
    #[repr(u32)]
    pub enum ProbeState {
        /// The probe succeeded.
        Ready = 1,
        /// A required capability was not found.
        Missing = 7,
    }
}

#[test]
fn contract_enum_preserves_repr_values_and_common_traits() {
    assert_eq!(ProbeState::Ready as u32, 1);
    assert_eq!(ProbeState::Missing as u32, 7);
    assert_eq!(ProbeState::Ready, ProbeState::Ready);
    assert_eq!(format!("{:?}", ProbeState::Missing), "Missing");
    let copied = ProbeState::Ready;
    let cloned = copied;
    assert_eq!(copied, cloned);
}
