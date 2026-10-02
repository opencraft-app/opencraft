macro_rules! pvm_abi {
    (
        constants { $($constant:ident: $ty:ty = $value:expr;)+ }
        $(#[$struct_meta:meta])*
        struct $struct_name:ident { $($field:ident: $field_ty:ty,)+ }
        size = $size:expr;
    ) => {
        $(
            #[doc = concat!("PVM ABI constant `", stringify!($constant), "`.")]
            pub const $constant: $ty = $value;
        )+

        $(#[$struct_meta])*
        #[allow(missing_docs)]
        #[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
        #[repr(C)]
        pub struct $struct_name {
            $(pub $field: $field_ty,)+
        }

        const _: () = assert!(core::mem::size_of::<$struct_name>() == $size);
    };
}

pvm_abi! {
    constants {
        MSR_LINEAR_ADDRESS_RANGE: u32 = 0x4b56_4df0;
        MSR_VCPU_STRUCT: u32 = 0x4b56_4df1;
        MSR_EVENT_ENTRY: u32 = 0x4b56_4df4;
        MSR_RETU_RIP: u32 = 0x4b56_4df5;
        HC_LOAD_PGTBL: u32 = 0x1708_8200;
        HC_TLB_INVLPG: u32 = 0x1708_8205;
        HC_LOAD_TLS: u32 = 0x1708_8209;
    }
    /// Published PVM virtual CPU structure.
    struct Pvcs {
        event_flags: u64,
        cr2: u64,
        reserved0: [u64; 6],
        user_cs: u16,
        user_ss: u16,
        event_errcode: u16,
        event_vector: u16,
        user_gsbase: u64,
        eflags: u32,
        pkru: u32,
        rip: u64,
        rcx: u64,
        r11: u64,
        reserved1: [u64; 2],
    }
    size = 128;
}

pvm_abi! {
    constants {
        MSR_SWITCH_CR3: u32 = 0x4b56_4df2;
        MSR_SUPERVISOR_RSP: u32 = 0x4b56_4df3;
        MSR_RETS_RIP: u32 = 0x4b56_4df6;
    }
    /// PVCS layout exposed by the installed 6.7-era PVM module.
    struct LegacyPvcs {
        event_flags: u64,
        event_errcode: u32,
        event_vector: u32,
        cr2: u64,
        reserved0: [u64; 5],
        user_cs: u16,
        user_ss: u16,
        reserved1: u32,
        reserved2: u64,
        user_gsbase: u64,
        eflags: u32,
        pkru: u32,
        rip: u64,
        rsp: u64,
        rcx: u64,
        r11: u64,
    }
    size = 128;
}
