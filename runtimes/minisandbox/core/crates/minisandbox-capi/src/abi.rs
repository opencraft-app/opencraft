use core::ffi::c_void;

/// Major version of the stable C ABI.
pub const ABI_VERSION_MAJOR: u32 = 1;

/// Minor version of the stable C ABI.
pub const ABI_VERSION_MINOR: u32 = 4;

/// Packs the major and minor C ABI versions into one value.
#[must_use]
pub const fn abi_version() -> u32 {
    (ABI_VERSION_MAJOR << 16) | ABI_VERSION_MINOR
}

/// Process-local, generation-checked object handle.
pub type Handle = u64;

/// One caller-owned immutable byte range.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(C)]
pub struct ByteSlice {
    /// First readable byte, or null only when `length` is zero.
    pub bytes: *const u8,
    /// Number of readable bytes.
    pub length: usize,
}

/// One exact, immutable file exposed to a Linux guest process.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(C)]
pub struct GuestFile {
    /// Absolute normalized guest path.
    pub path: ByteSlice,
    /// Complete immutable file contents.
    pub contents: ByteSlice,
}

/// Stable result code returned by every fallible C entry point.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Status {
    /// Operation completed successfully.
    Ok = 0,
    /// A pointer, size, version, or other argument was invalid.
    InvalidArgument = 1,
    /// The host does not provide the required PVM ABI.
    UnsupportedPvm = 2,
    /// The handle is stale, malformed, or belongs to another process.
    InvalidHandle = 3,
    /// The handle names a different object kind than the operation requires.
    WrongHandleKind = 4,
    /// The object is already executing or the call would re-enter it.
    Busy = 5,
    /// Guest execution terminated with a fault.
    GuestFault = 6,
    /// Guest execution exceeded its deadline.
    Timeout = 7,
    /// A caller-provided host callback reported failure.
    HostError = 8,
    /// An internal failure or contained Rust panic occurred.
    Internal = 255,
}

/// Options for creating a minisandbox runtime.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(C)]
pub struct RuntimeOptions {
    /// Number of readable bytes supplied by the caller.
    pub struct_size: u32,
    /// ABI version returned by [`abi_version`].
    pub abi_version: u32,
    /// Maximum guest memory in bytes.
    pub max_memory: u64,
    /// Requested number of virtual CPUs.
    pub vcpu_count: u32,
    /// Reserved feature flags; must currently be zero.
    pub flags: u32,
}

impl Default for RuntimeOptions {
    fn default() -> Self {
        Self {
            struct_size: u32::try_from(core::mem::size_of::<Self>())
                .expect("C ABI structure size exceeds u32"),
            abi_version: abi_version(),
            max_memory: 64 * 1024 * 1024,
            vcpu_count: 1,
            flags: 0,
        }
    }
}

/// Options for one synchronous instance run.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(C)]
pub struct RunOptions {
    /// Number of readable bytes supplied by the caller.
    pub struct_size: u32,
    /// ABI version returned by [`abi_version`].
    pub abi_version: u32,
    /// Wall-clock deadline in nanoseconds.
    pub timeout_ns: u64,
}

impl Default for RunOptions {
    fn default() -> Self {
        Self {
            struct_size: u32::try_from(core::mem::size_of::<Self>())
                .expect("C ABI structure size exceeds u32"),
            abi_version: abi_version(),
            timeout_ns: 30_000_000_000,
        }
    }
}

/// Caller-owned synchronous output sink.
pub type OutputCallback =
    Option<unsafe extern "C" fn(context: *mut c_void, bytes: *const u8, length: usize) -> Status>;
