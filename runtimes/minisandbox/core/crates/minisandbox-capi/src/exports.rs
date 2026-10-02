//! Panic-contained exported C calling convention.

use std::{
    cell::Cell,
    ffi::{CStr, c_char, c_void},
    panic::{AssertUnwindSafe, catch_unwind},
    time::Duration,
};

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
use minisandbox_core::engine::{
    Engine, EngineError, ProcessFile as CoreProcessFile, RunOptions as CoreRunOptions, RunOutcome,
};
use minisandbox_core::program::Program;

use crate::{
    ABI_VERSION_MAJOR, ABI_VERSION_MINOR, ByteSlice, GuestFile, Handle, OutputCallback, RunOptions,
    RuntimeOptions, Status, registry,
};

const RUNTIME_OPTIONS_PREFIX_SIZE: usize = core::mem::offset_of!(RuntimeOptions, max_memory);
const MAX_PROCESS_VECTOR_ENTRIES: usize = 1024;
const MAX_PROCESS_FILES: usize = 64;

#[derive(Clone, Copy)]
struct GuestFileRef<'a> {
    path: &'a [u8],
    contents: &'a [u8],
}

thread_local! {
    static LAST_ERROR: Cell<Status> = const { Cell::new(Status::Ok) };
}

/// Returns the packed major/minor version of the stable C ABI.
#[unsafe(no_mangle)]
pub extern "C" fn minisandbox_abi_version() -> u32 {
    crate::abi_version()
}

/// Returns a process-owned description of the last failure on this thread.
///
/// The returned NUL-terminated string has static storage duration and must not
/// be freed. It is empty before the first failure.
#[unsafe(no_mangle)]
pub extern "C" fn minisandbox_last_error() -> *const c_char {
    LAST_ERROR.with(|last_error| status_message(last_error.get()).as_ptr())
}

/// Creates one process-local runtime handle.
///
/// # Safety
///
/// `options` must point to a readable [`RuntimeOptions`] and `out_runtime`
/// must point to writable storage for one [`Handle`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn minisandbox_runtime_create(
    options: *const RuntimeOptions,
    out_runtime: *mut Handle,
) -> Status {
    boundary(|| {
        if options.is_null() || out_runtime.is_null() {
            return Err(Status::InvalidArgument);
        }
        // SAFETY: The caller contract above requires a readable structure-size
        // field at the start of the extensible input.
        let struct_size = unsafe { options.cast::<u32>().read_unaligned() };
        if usize::try_from(struct_size).map_err(|_| Status::InvalidArgument)?
            < RUNTIME_OPTIONS_PREFIX_SIZE
        {
            return Err(Status::InvalidArgument);
        }
        // SAFETY: A validated prefix includes the second u32 ABI-version field.
        let version = unsafe { options.cast::<u32>().add(1).read_unaligned() };
        let major = version >> 16;
        let minor = version & 0xffff;
        if major != ABI_VERSION_MAJOR || minor > ABI_VERSION_MINOR {
            return Err(Status::InvalidArgument);
        }
        let handle = registry::insert_runtime()?;
        // SAFETY: The caller contract above requires writable handle storage.
        unsafe { out_runtime.write_unaligned(handle) };
        Ok(())
    })
}

/// Releases one generation-checked process-local object handle.
#[unsafe(no_mangle)]
pub extern "C" fn minisandbox_release(handle: Handle) -> Status {
    boundary(|| registry::release(handle))
}

/// Parses supported ELF bytes into one process-local program handle.
///
/// # Safety
///
/// `bytes` must refer to `length` readable bytes and `out_program` must point
/// to writable storage for one [`Handle`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn minisandbox_program_load(
    runtime: Handle,
    bytes: *const u8,
    length: usize,
    out_program: *mut Handle,
) -> Status {
    boundary(|| {
        if bytes.is_null() || out_program.is_null() {
            return Err(Status::InvalidArgument);
        }
        // SAFETY: The caller contract requires a readable byte range.
        let bytes = unsafe { std::slice::from_raw_parts(bytes, length) };
        let program = Program::parse_elf(bytes).map_err(|_| Status::InvalidArgument)?;
        let handle = registry::insert_program(runtime, program)?;
        // SAFETY: The caller contract requires writable handle storage.
        unsafe { out_program.write_unaligned(handle) };
        Ok(())
    })
}

/// Creates an independently owned instance from runtime and program handles.
///
/// # Safety
///
/// `out_instance` must point to writable storage for one [`Handle`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn minisandbox_instance_create(
    runtime: Handle,
    program: Handle,
    out_instance: *mut Handle,
) -> Status {
    boundary(|| {
        if out_instance.is_null() {
            return Err(Status::InvalidArgument);
        }
        let handle = registry::insert_instance(runtime, program)?;
        // SAFETY: The caller contract requires writable handle storage.
        unsafe { out_instance.write_unaligned(handle) };
        Ok(())
    })
}

/// Seals a validated program as an immutable copy-on-write template.
///
/// # Safety
///
/// `out_template` must point to writable storage for one [`Handle`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn minisandbox_template_create(
    runtime: Handle,
    program: Handle,
    out_template: *mut Handle,
) -> Status {
    boundary(|| {
        if out_template.is_null() {
            return Err(Status::InvalidArgument);
        }
        let program = registry::program_for_template(runtime, program)?;
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        let template = {
            let engine = Engine::open().map_err(|_| Status::UnsupportedPvm)?;
            engine
                .seal_template(&program)
                .map_err(|_| Status::Internal)?
        };
        #[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
        {
            let _ = program;
            return Err(Status::UnsupportedPvm);
        }
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        {
            let handle = registry::insert_template(runtime, template)?;
            // SAFETY: The caller contract requires writable handle storage.
            unsafe { out_template.write_unaligned(handle) };
            Ok(())
        }
    })
}

/// Warms `QuickJS` with deployment source and seals its Actor-turn checkpoint.
///
/// # Safety
///
/// `deployment` must refer to `deployment_length` readable bytes and
/// `out_template` must point to writable storage for one [`Handle`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn minisandbox_actor_template_warm(
    runtime: Handle,
    program: Handle,
    deployment: *const u8,
    deployment_length: usize,
    out_template: *mut Handle,
) -> Status {
    boundary(|| {
        if deployment.is_null() || out_template.is_null() {
            return Err(Status::InvalidArgument);
        }
        // SAFETY: The caller contract requires a readable deployment range.
        let deployment = unsafe { std::slice::from_raw_parts(deployment, deployment_length) };
        let program = registry::program_for_template(runtime, program)?;
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        let template = {
            let engine = Engine::open().map_err(|_| Status::UnsupportedPvm)?;
            engine
                .warm_actor_template(&program, deployment)
                .map_err(|error| engine_status(&error))?
        };
        #[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
        {
            let _ = (program, deployment);
            return Err(Status::UnsupportedPvm);
        }
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        {
            let handle = registry::insert_template(runtime, template)?;
            // SAFETY: The caller contract requires writable handle storage.
            unsafe { out_template.write_unaligned(handle) };
            Ok(())
        }
    })
}

/// Creates one ephemeral instance from a sealed template handle.
///
/// The VM, vCPU, and private memory view are created when the one-shot instance
/// is run; no KVM descriptor is inherited or shared with the template.
///
/// # Safety
///
/// `out_instance` must point to writable storage for one [`Handle`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn minisandbox_instance_fork(
    runtime: Handle,
    template: Handle,
    out_instance: *mut Handle,
) -> Status {
    boundary(|| {
        if out_instance.is_null() {
            return Err(Status::InvalidArgument);
        }
        let handle = registry::insert_cow_instance(runtime, template)?;
        // SAFETY: The caller contract requires writable handle storage.
        unsafe { out_instance.write_unaligned(handle) };
        Ok(())
    })
}

/// Runs one instance synchronously and forwards captured output to the caller.
///
/// # Safety
///
/// `options` must point to a readable [`RunOptions`]. If `output` is present,
/// `output_context` must satisfy that callback's caller-defined contract.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn minisandbox_instance_run(
    instance: Handle,
    options: *const RunOptions,
    output: OutputCallback,
    output_context: *mut c_void,
) -> Status {
    boundary(|| {
        // SAFETY: The exported function forwards its readable options contract.
        let timeout = unsafe { read_run_timeout(options)? };
        run_instance(instance, timeout, None, output, output_context)
    })
}

/// Runs one JSON Actor turn from a warmed template instance.
///
/// # Safety
///
/// `input` must refer to `input_length` readable bytes and `options` must point
/// to a readable [`RunOptions`]. If `output` is present, `output_context` must
/// satisfy that callback's caller-defined contract.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn minisandbox_instance_run_turn(
    instance: Handle,
    input: *const u8,
    input_length: usize,
    options: *const RunOptions,
    output: OutputCallback,
    output_context: *mut c_void,
) -> Status {
    boundary(|| {
        if input.is_null() {
            return Err(Status::InvalidArgument);
        }
        // SAFETY: The caller contract requires a readable turn-input range.
        let input = unsafe { std::slice::from_raw_parts(input, input_length) };
        // SAFETY: The exported function forwards its readable options contract.
        let timeout = unsafe { read_run_timeout(options)? };
        run_instance(instance, timeout, Some(input), output, output_context)
    })
}

/// Runs one program-backed instance with Linux process inputs.
///
/// # Safety
///
/// Each non-empty argument/environment slice and `stdin` must remain readable
/// for the synchronous call. `options` and any output callback context must
/// satisfy the same contracts as [`minisandbox_instance_run`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn minisandbox_instance_run_process(
    instance: Handle,
    arguments: *const ByteSlice,
    argument_count: usize,
    environment: *const ByteSlice,
    environment_count: usize,
    stdin: *const u8,
    stdin_length: usize,
    options: *const RunOptions,
    output: OutputCallback,
    output_context: *mut c_void,
) -> Status {
    boundary(|| {
        // SAFETY: The exported contract requires every described range to
        // remain readable until this synchronous call returns.
        let arguments = unsafe { read_byte_slices(arguments, argument_count)? };
        // SAFETY: The same contract applies independently to environment data.
        let environment = unsafe { read_byte_slices(environment, environment_count)? };
        // SAFETY: The exported contract covers the stdin byte range.
        let stdin = unsafe { read_byte_range(stdin, stdin_length)? };
        // SAFETY: The exported function forwards its readable options contract.
        let timeout = unsafe { read_run_timeout(options)? };
        run_process_instance(
            instance,
            timeout,
            &arguments,
            &environment,
            stdin,
            &[],
            output,
            output_context,
        )
    })
}

/// Runs one program-backed instance with Linux inputs and exact read-only files.
///
/// # Safety
///
/// Every argument, environment, stdin, file descriptor, file path, and file
/// content range must remain readable for the synchronous call. `options` and
/// any output callback context must satisfy the same contracts as
/// [`minisandbox_instance_run`].
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn minisandbox_instance_run_process_with_files(
    instance: Handle,
    arguments: *const ByteSlice,
    argument_count: usize,
    environment: *const ByteSlice,
    environment_count: usize,
    stdin: *const u8,
    stdin_length: usize,
    files: *const GuestFile,
    file_count: usize,
    options: *const RunOptions,
    output: OutputCallback,
    output_context: *mut c_void,
) -> Status {
    boundary(|| {
        // SAFETY: The exported contract keeps each described range readable.
        let arguments = unsafe { read_byte_slices(arguments, argument_count)? };
        // SAFETY: The same contract applies independently to environment data.
        let environment = unsafe { read_byte_slices(environment, environment_count)? };
        // SAFETY: The exported contract covers the stdin byte range.
        let stdin = unsafe { read_byte_range(stdin, stdin_length)? };
        // SAFETY: The exported contract covers all file descriptors and ranges.
        let files = unsafe { read_guest_files(files, file_count)? };
        // SAFETY: The exported function forwards its readable options contract.
        let timeout = unsafe { read_run_timeout(options)? };
        run_process_instance(
            instance,
            timeout,
            &arguments,
            &environment,
            stdin,
            &files,
            output,
            output_context,
        )
    })
}

/// Copies the last successful guest exit code from an instance.
///
/// # Safety
///
/// `out_exit_code` must point to writable storage for one `i32`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn minisandbox_instance_exit_code(
    instance: Handle,
    out_exit_code: *mut i32,
) -> Status {
    boundary(|| {
        if out_exit_code.is_null() {
            return Err(Status::InvalidArgument);
        }
        let instance = registry::instance(instance)?;
        let exit_code = instance.exit_code().ok_or(Status::InvalidArgument)?;
        // SAFETY: The caller contract requires writable result storage.
        unsafe { out_exit_code.write_unaligned(exit_code) };
        Ok(())
    })
}

/// Copies the number of private 4 KiB data pages from the last successful run.
///
/// # Safety
///
/// `out_dirty_pages` must point to writable storage for one `u64`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn minisandbox_instance_dirty_pages(
    instance: Handle,
    out_dirty_pages: *mut u64,
) -> Status {
    boundary(|| {
        if out_dirty_pages.is_null() {
            return Err(Status::InvalidArgument);
        }
        let instance = registry::instance(instance)?;
        let dirty_pages = instance.dirty_pages().ok_or(Status::InvalidArgument)?;
        let dirty_pages = u64::try_from(dirty_pages).map_err(|_| Status::Internal)?;
        // SAFETY: The caller contract requires writable result storage.
        unsafe { out_dirty_pages.write_unaligned(dirty_pages) };
        Ok(())
    })
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn run_instance(
    instance: Handle,
    timeout: Duration,
    input: Option<&[u8]>,
    output: OutputCallback,
    output_context: *mut c_void,
) -> Result<(), Status> {
    let instance = registry::instance(instance)?;
    if instance.requires_turn_input() != input.is_some() {
        return Err(Status::InvalidArgument);
    }
    let run = instance.begin_run()?;
    run.set_exit_code(None);
    run.set_dirty_pages(None);
    let engine = Engine::open().map_err(|_| Status::UnsupportedPvm)?;
    let result = match run.source() {
        registry::InstanceSource::Program(program) => {
            if input.is_some() {
                return Err(Status::InvalidArgument);
            }
            engine
                .run_with_options(program, CoreRunOptions { timeout })
                .map_err(|error| engine_status(&error))?
        }
        registry::InstanceSource::Template(template) => {
            let mut child = engine
                .fork_template(template)
                .map_err(|error| engine_status(&error))?;
            let result = match (template.is_actor_template(), input) {
                (true, Some(input)) => child
                    .run_turn_with_options(input, CoreRunOptions { timeout })
                    .map_err(|error| engine_status(&error))?,
                (false, None) => child
                    .run_with_options(CoreRunOptions { timeout })
                    .map_err(|error| engine_status(&error))?,
                _ => return Err(Status::InvalidArgument),
            };
            run.set_dirty_pages(Some(child.stats().dirty_data_pages));
            result
        }
    };
    complete_run(&run, &result, output, output_context)
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[allow(clippy::too_many_arguments)]
fn run_process_instance(
    instance: Handle,
    timeout: Duration,
    arguments: &[&[u8]],
    environment: &[&[u8]],
    stdin: &[u8],
    files: &[GuestFileRef<'_>],
    output: OutputCallback,
    output_context: *mut c_void,
) -> Result<(), Status> {
    let instance = registry::instance(instance)?;
    if !instance.accepts_process_input() {
        return Err(Status::InvalidArgument);
    }
    let run = instance.begin_run()?;
    run.set_exit_code(None);
    run.set_dirty_pages(None);
    let registry::InstanceSource::Program(program) = run.source() else {
        return Err(Status::Internal);
    };
    let files = files
        .iter()
        .map(|file| CoreProcessFile {
            path: file.path,
            bytes: file.contents,
        })
        .collect::<Vec<_>>();
    let result = Engine::open()
        .map_err(|_| Status::UnsupportedPvm)?
        .run_process_with_files_and_options(
            program,
            arguments,
            environment,
            stdin,
            &files,
            CoreRunOptions { timeout },
        )
        .map_err(|error| engine_status(&error))?;
    complete_run(&run, &result, output, output_context)
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn complete_run(
    run: &registry::InstanceRunGuard,
    result: &minisandbox_core::engine::RunResult,
    output: OutputCallback,
    output_context: *mut c_void,
) -> Result<(), Status> {
    match result.outcome {
        RunOutcome::Exited { code } => run.set_exit_code(Some(code)),
        RunOutcome::GuestFault => return Err(Status::GuestFault),
        RunOutcome::TimedOut => return Err(Status::Timeout),
        // The C API has no cancellation entry point or status yet. Keep the
        // stable ABI unchanged while Rust product runners adopt cancellation.
        RunOutcome::Cancelled | RunOutcome::Halted | RunOutcome::Shutdown => {
            return Err(Status::Internal);
        }
    }
    if !result.output.is_empty()
        && let Some(callback) = output
    {
        // SAFETY: The callback is invoked synchronously with the caller-owned
        // context and a slice live until the callback returns.
        let status =
            unsafe { callback(output_context, result.output.as_ptr(), result.output.len()) };
        if status != Status::Ok {
            return Err(Status::HostError);
        }
    }
    Ok(())
}

#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
fn run_instance(
    instance: Handle,
    _timeout: Duration,
    _input: Option<&[u8]>,
    _output: OutputCallback,
    _output_context: *mut c_void,
) -> Result<(), Status> {
    let instance = registry::instance(instance)?;
    let run = instance.begin_run()?;
    let _ = run.source();
    Err(Status::UnsupportedPvm)
}

#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
#[allow(clippy::too_many_arguments)]
fn run_process_instance(
    instance: Handle,
    _timeout: Duration,
    _arguments: &[&[u8]],
    _environment: &[&[u8]],
    _stdin: &[u8],
    _files: &[GuestFileRef<'_>],
    _output: OutputCallback,
    _output_context: *mut c_void,
) -> Result<(), Status> {
    let instance = registry::instance(instance)?;
    if !instance.accepts_process_input() {
        return Err(Status::InvalidArgument);
    }
    let run = instance.begin_run()?;
    let _ = run.source();
    Err(Status::UnsupportedPvm)
}

unsafe fn read_guest_files<'a>(
    files: *const GuestFile,
    count: usize,
) -> Result<Vec<GuestFileRef<'a>>, Status> {
    if count > MAX_PROCESS_FILES || (count != 0 && files.is_null()) {
        return Err(Status::InvalidArgument);
    }
    if count == 0 {
        return Ok(Vec::new());
    }
    // SAFETY: The caller contract supplies `count` readable descriptors.
    let files = unsafe { std::slice::from_raw_parts(files, count) };
    files
        .iter()
        .map(|file| {
            // SAFETY: Each descriptor path is covered by the exported contract.
            let path = unsafe { read_byte_range(file.path.bytes, file.path.length)? };
            // SAFETY: Each content range is covered by the exported contract.
            let contents = unsafe { read_byte_range(file.contents.bytes, file.contents.length)? };
            Ok(GuestFileRef { path, contents })
        })
        .collect()
}

unsafe fn read_byte_slices<'a>(
    slices: *const ByteSlice,
    count: usize,
) -> Result<Vec<&'a [u8]>, Status> {
    if count > MAX_PROCESS_VECTOR_ENTRIES || (count != 0 && slices.is_null()) {
        return Err(Status::InvalidArgument);
    }
    if count == 0 {
        return Ok(Vec::new());
    }
    // SAFETY: The caller contract supplies `count` readable descriptors.
    let slices = unsafe { std::slice::from_raw_parts(slices, count) };
    slices
        .iter()
        .map(|slice| {
            // SAFETY: Each descriptor is covered by the exported caller contract.
            unsafe { read_byte_range(slice.bytes, slice.length) }
        })
        .collect()
}

unsafe fn read_byte_range<'a>(bytes: *const u8, length: usize) -> Result<&'a [u8], Status> {
    if length == 0 {
        return Ok(&[]);
    }
    if bytes.is_null() {
        return Err(Status::InvalidArgument);
    }
    // SAFETY: The caller contract supplies exactly `length` readable bytes.
    Ok(unsafe { std::slice::from_raw_parts(bytes, length) })
}

unsafe fn read_run_timeout(options: *const RunOptions) -> Result<Duration, Status> {
    if options.is_null() {
        return Err(Status::InvalidArgument);
    }
    // SAFETY: The caller provides the two-u32 versioned prefix.
    let struct_size = unsafe { options.cast::<u32>().read_unaligned() };
    if usize::try_from(struct_size).map_err(|_| Status::InvalidArgument)?
        < core::mem::size_of::<RunOptions>()
    {
        return Err(Status::InvalidArgument);
    }
    // SAFETY: The advertised readable prefix includes this second word.
    let version = unsafe { options.cast::<u32>().add(1).read_unaligned() };
    validate_prefix(struct_size, version, core::mem::size_of::<RunOptions>())?;
    // SAFETY: The validated known prefix includes the timeout field.
    let timeout_ns = unsafe {
        options
            .cast::<u8>()
            .add(core::mem::offset_of!(RunOptions, timeout_ns))
            .cast::<u64>()
            .read_unaligned()
    };
    Ok(Duration::from_nanos(timeout_ns))
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn engine_status(error: &EngineError) -> Status {
    match error {
        EngineError::ActorPayloadTooLarge
        | EngineError::InvalidActorProtocol
        | EngineError::InstanceAlreadyRun
        | EngineError::InvalidProcessInput
        | EngineError::ProcessInputTooLarge
        | EngineError::UnsupportedInterpreter => Status::InvalidArgument,
        EngineError::ActorWarmupFailed(_) => Status::GuestFault,
        EngineError::OutputLimitExceeded => Status::HostError,
        EngineError::Pvm(_)
        | EngineError::Image(_)
        | EngineError::LinuxImage(_)
        | EngineError::InvalidSyscallExit
        | EngineError::InvalidExitCode
        | EngineError::UnexpectedExit(_)
        | EngineError::ExitBudgetExceeded
        | EngineError::InvalidCowFault
        | EngineError::HostEntropy(_)
        | EngineError::HostClock(_)
        | EngineError::RuntimeElf(_)
        | EngineError::HostRuntime(_)
        | EngineError::LinuxCheckpoint(_)
        | EngineError::SocketService(_) => Status::Internal,
    }
}

fn boundary(operation: impl FnOnce() -> Result<(), Status>) -> Status {
    let status = match catch_unwind(AssertUnwindSafe(operation)) {
        Ok(Ok(())) => Status::Ok,
        Ok(Err(status)) => status,
        Err(_) => Status::Internal,
    };
    LAST_ERROR.with(|last_error| last_error.set(status));
    status
}

const fn status_message(status: Status) -> &'static CStr {
    match status {
        Status::Ok => c"",
        Status::InvalidArgument => c"invalid argument",
        Status::UnsupportedPvm => c"PVM is not supported by this host",
        Status::InvalidHandle => c"invalid or stale handle",
        Status::WrongHandleKind => c"wrong handle kind",
        Status::Busy => c"object is busy",
        Status::GuestFault => c"guest fault",
        Status::Timeout => c"guest execution timed out",
        Status::HostError => c"host callback failed",
        Status::Internal => c"internal error",
    }
}

fn validate_prefix(struct_size: u32, version: u32, minimum_size: usize) -> Result<(), Status> {
    if usize::try_from(struct_size).map_err(|_| Status::InvalidArgument)? < minimum_size {
        return Err(Status::InvalidArgument);
    }
    let major = version >> 16;
    let minor = version & 0xffff;
    if major != ABI_VERSION_MAJOR || minor > ABI_VERSION_MINOR {
        return Err(Status::InvalidArgument);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{Status, boundary, minisandbox_last_error};
    use std::ffi::CStr;

    #[test]
    fn boundary_maps_panics_to_internal_without_unwinding() {
        assert_eq!(
            boundary(|| panic!("injected boundary panic")),
            Status::Internal
        );
        // SAFETY: The ABI returns a non-null static C string.
        assert_eq!(
            unsafe { CStr::from_ptr(minisandbox_last_error()) }.to_bytes(),
            b"internal error"
        );
    }
}
