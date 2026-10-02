//! Contract tests for PVM control constants and PVCS layouts.

use core::mem::{align_of, offset_of, size_of};

use minisandbox_pvm_sys::{
    HC_LOAD_PGTBL, HC_LOAD_TLS, HC_TLB_INVLPG, LegacyPvcs, MSR_EVENT_ENTRY,
    MSR_LINEAR_ADDRESS_RANGE, MSR_RETS_RIP, MSR_RETU_RIP, MSR_SUPERVISOR_RSP, MSR_SWITCH_CR3,
    MSR_VCPU_STRUCT, Pvcs,
};

#[test]
fn published_pvcs_layout_and_control_numbers_are_exact() {
    assert_eq!(size_of::<Pvcs>(), 128);
    assert_eq!(align_of::<Pvcs>(), align_of::<u64>());
    assert_eq!(offset_of!(Pvcs, event_flags), 0);
    assert_eq!(offset_of!(Pvcs, cr2), 8);
    assert_eq!(offset_of!(Pvcs, user_cs), 64);
    assert_eq!(offset_of!(Pvcs, event_vector), 70);
    assert_eq!(offset_of!(Pvcs, user_gsbase), 72);
    assert_eq!(offset_of!(Pvcs, eflags), 80);
    assert_eq!(offset_of!(Pvcs, rip), 88);
    assert_eq!(offset_of!(Pvcs, rcx), 96);
    assert_eq!(offset_of!(Pvcs, r11), 104);

    assert_eq!(MSR_LINEAR_ADDRESS_RANGE, 0x4b56_4df0);
    assert_eq!(MSR_VCPU_STRUCT, 0x4b56_4df1);
    assert_eq!(MSR_EVENT_ENTRY, 0x4b56_4df4);
    assert_eq!(MSR_RETU_RIP, 0x4b56_4df5);
    assert_eq!(HC_LOAD_PGTBL, 0x1708_8200);
    assert_eq!(HC_TLB_INVLPG, 0x1708_8205);
    assert_eq!(HC_LOAD_TLS, 0x1708_8209);
}

#[test]
fn installed_legacy_pvcs_layout_is_explicit() {
    assert_eq!(size_of::<LegacyPvcs>(), 128);
    assert_eq!(align_of::<LegacyPvcs>(), align_of::<u64>());
    assert_eq!(offset_of!(LegacyPvcs, event_flags), 0);
    assert_eq!(offset_of!(LegacyPvcs, event_errcode), 8);
    assert_eq!(offset_of!(LegacyPvcs, event_vector), 12);
    assert_eq!(offset_of!(LegacyPvcs, cr2), 16);
    assert_eq!(offset_of!(LegacyPvcs, user_cs), 64);
    assert_eq!(offset_of!(LegacyPvcs, user_gsbase), 80);
    assert_eq!(offset_of!(LegacyPvcs, eflags), 88);
    assert_eq!(offset_of!(LegacyPvcs, rip), 96);
    assert_eq!(offset_of!(LegacyPvcs, rsp), 104);
    assert_eq!(offset_of!(LegacyPvcs, rcx), 112);
    assert_eq!(offset_of!(LegacyPvcs, r11), 120);

    assert_eq!(MSR_SWITCH_CR3, 0x4b56_4df2);
    assert_eq!(MSR_SUPERVISOR_RSP, 0x4b56_4df3);
    assert_eq!(MSR_RETS_RIP, 0x4b56_4df6);
}
