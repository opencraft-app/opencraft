//! Safe encoding of PVM control-page state.

use minisandbox_pvm_sys::{PVM_EVENT_PORT_BASE, PvmAbi, PvmBootConfig};

use crate::{
    memory::{GuestAddress, GuestMemory, MemoryError},
    paging::{CowPagePlan, PagePermissions, PageRoot, PageTablePlan, PagingError},
    program::Program,
};

const PAGE_SIZE: usize = 4096;
const PAGE_SIZE_U64: u64 = 4096;
const USER_CS: u16 = 0x33;
const USER_SS: u16 = 0x2b;
const LEGACY_EVENT_ENABLE: u64 = 1;
const MODERN_STANDARD_EVENT_VECTOR: u16 = 0x100;
const MEMORY_SIZE: usize = 2 * 1024 * 1024;
const ACTOR_MEMORY_SIZE: usize = 64 * 1024 * 1024;
const TABLE_BASE: u64 = 0x1000;
const ACTOR_TABLE_BASE: u64 = 0x1_0000;
const PVCS: u64 = 0x9000;
const SUPERVISOR_CODE: u64 = 0xa000;
const LSTAR: u64 = SUPERVISOR_CODE + 0x100;
const EVENT_ENTRY: u64 = SUPERVISOR_CODE + 0x200;
const LEGACY_RETS: u64 = SUPERVISOR_CODE + 0x600;
const USER_CODE: u64 = 0xc000;
const USER_STACK: u64 = 0xd000;
const SUPERVISOR_STACK: u64 = 0xe000;
const GDT: u64 = 0xf000;
const ACTOR_HEAP_START: u64 = 0x0100_0000;
const ACTOR_HEAP_END: u64 = 0x0300_0000;
const ACTOR_STACK_START: u64 = 0x03f0_0000;
const ACTOR_STACK_END: u64 = 0x0400_0000;
const PROCESS_MMAP_START: u64 = ACTOR_HEAP_END;
const PROCESS_MMAP_END: u64 = ACTOR_STACK_START;
const GENERIC_EXECUTABLE_NAME: &[u8] = b"/minisandbox/program";
const ACTOR_EXECUTABLE_NAME: &[u8] = b"/minisandbox/quickjs-actor";
const MAX_PROCESS_VECTOR_ENTRIES: usize = 1024;
const MAX_PROCESS_STRING_BYTES: usize = 512 * 1024;
const TRANSITION_MAGIC: u32 = 0x5056_4d51;
const EVENT_FAILURE_MAGIC: u32 = 0x4552_5221;

macro_rules! encode_fields {
    ($page:expr, $($offset:expr => $value:expr),+ $(,)?) => {{
        $(put($page, $offset, $value.to_le_bytes());)+
    }};
}

/// Complete logical user frame consumed by PVM user entry.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PvmUserFrame {
    /// User instruction pointer.
    pub rip: u64,
    /// User stack pointer.
    pub rsp: u64,
    /// User RFLAGS value.
    pub rflags: u32,
    /// User RCX value.
    pub rcx: u64,
    /// User R11 value.
    pub r11: u64,
    /// User GS base restored by PVM.
    pub user_gsbase: u64,
}

/// One zero-padded 4 KiB PVM virtual CPU structure backing page.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PvcsPage {
    bytes: Box<[u8; PAGE_SIZE]>,
}

/// Failure while constructing an isolated PVM guest image.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PvmImageError {
    /// Checked guest-memory installation failed.
    Memory(MemoryError),
    /// Page-table planning or materialization failed.
    Paging(PagingError),
    /// Program pages overflow or exceed the phase-one memory image.
    ProgramLayout,
}

/// Runtime-internal page selected by a live user-isolation probe.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IsolationTarget {
    /// Supervisor ERETU/LSTAR/event code page.
    SupervisorCode,
    /// PVM virtual CPU structure backing page.
    Pvcs,
    /// Supervisor PML4 page.
    PageTables,
}

/// Memory operation attempted by a live user-isolation probe.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IsolationAccess {
    /// Load one machine word.
    Read,
    /// Store one machine word.
    Write,
}

/// Complete memory and boot-control image for one PVM user entry.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PvmUserImage {
    memory: GuestMemory,
    boot: PvmBootConfig,
    cow_pages: CowPagePlan,
    linux_process: Option<LinuxProcessLayout>,
}

/// Fixed bounded regions used by a static Linux process.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LinuxProcessLayout {
    brk_start: GuestAddress,
    brk_limit: GuestAddress,
    stack_limit: u64,
    random_seed: GuestAddress,
    mmap_start: GuestAddress,
    mmap_limit: GuestAddress,
    executable_name: &'static [u8],
}

impl LinuxProcessLayout {
    /// Returns the first address reported by `brk(0)`.
    #[must_use]
    pub const fn brk_start(self) -> GuestAddress {
        self.brk_start
    }

    /// Returns the exclusive maximum accepted program break.
    #[must_use]
    pub const fn brk_limit(self) -> GuestAddress {
        self.brk_limit
    }

    /// Returns the fixed stack resource limit exposed to libc.
    #[must_use]
    pub const fn stack_limit(self) -> u64 {
        self.stack_limit
    }

    /// Returns the 16-byte `AT_RANDOM` seed location on the initial stack.
    #[must_use]
    pub const fn random_seed(self) -> GuestAddress {
        self.random_seed
    }

    /// Returns the first address in the bounded anonymous-mapping arena.
    #[must_use]
    pub const fn mmap_start(self) -> GuestAddress {
        self.mmap_start
    }

    /// Returns the exclusive end of the anonymous-mapping arena.
    #[must_use]
    pub const fn mmap_limit(self) -> GuestAddress {
        self.mmap_limit
    }

    /// Returns the virtual `/proc/self/exe` path without a trailing NUL.
    #[must_use]
    pub const fn executable_name(self) -> &'static [u8] {
        self.executable_name
    }
}

impl PvmUserImage {
    /// Builds a minimal double-root image whose user stream invokes SYSCALL.
    ///
    /// # Errors
    ///
    /// Returns [`PvmImageError`] if any address, mapping, table installation,
    /// PVCS write, code write, or GDT write violates a checked layout contract.
    pub fn transition_probe(abi: PvmAbi) -> Result<Self, PvmImageError> {
        let address = |raw| GuestAddress::new(raw).map_err(PvmImageError::Memory);
        let mut plan = PageTablePlan::new();
        for raw in [PVCS, SUPERVISOR_STACK, GDT] {
            let page = address(raw)?;
            plan.map_supervisor(page, page, PagePermissions::READ_WRITE)
                .map_err(PvmImageError::Paging)?;
        }
        let supervisor_code = address(SUPERVISOR_CODE)?;
        plan.map_supervisor(
            supervisor_code,
            supervisor_code,
            PagePermissions::READ_EXECUTE,
        )
        .map_err(PvmImageError::Paging)?;
        let user_code = address(USER_CODE)?;
        plan.map_user(user_code, user_code, PagePermissions::READ_EXECUTE)
            .map_err(PvmImageError::Paging)?;
        let user_stack = address(USER_STACK)?;
        plan.map_user(user_stack, user_stack, PagePermissions::READ_WRITE)
            .map_err(PvmImageError::Paging)?;

        let tables = plan
            .materialize_4k(address(TABLE_BASE)?)
            .map_err(PvmImageError::Paging)?;
        let mut memory = GuestMemory::new(MEMORY_SIZE);
        tables.install(&mut memory).map_err(PvmImageError::Memory)?;

        let frame = PvmUserFrame {
            rip: USER_CODE,
            rsp: USER_STACK + PAGE_SIZE_U64 - 16,
            rflags: 0x202,
            rcx: 0,
            r11: 0,
            user_gsbase: 0,
        };
        memory
            .write(address(PVCS)?, PvcsPage::new(abi, frame).as_bytes())
            .map_err(PvmImageError::Memory)?;
        install_probe_code(&mut memory)?;
        install_gdt(&mut memory)?;

        Ok(Self {
            memory,
            boot: PvmBootConfig {
                abi,
                supervisor_cr3: tables.root(PageRoot::Supervisor).get(),
                user_cr3: tables.root(PageRoot::User).get(),
                pvcs_gpa: PVCS,
                retu_rip: SUPERVISOR_CODE,
                event_entry: EVENT_ENTRY,
                legacy_rets_rip: LEGACY_RETS,
                lstar: LSTAR,
                supervisor_rsp: SUPERVISOR_STACK + PAGE_SIZE_U64,
                user_rsp: frame.rsp,
                gdt_base: GDT,
                gdt_limit: 7 * 8 - 1,
            },
            cow_pages: CowPagePlan::default(),
            linux_process: None,
        })
    }

    /// Builds a user stream that accesses one runtime-internal page before its
    /// normal SYSCALL. Correct user-root isolation routes the access to the PVM
    /// event entry; an accidental mapping reaches LSTAR instead.
    ///
    /// # Errors
    ///
    /// Returns [`PvmImageError`] if the base image or replacement user stream
    /// violates a checked memory/layout contract.
    pub fn isolation_probe(
        abi: PvmAbi,
        target: IsolationTarget,
        access: IsolationAccess,
    ) -> Result<Self, PvmImageError> {
        let mut image = Self::transition_probe(abi)?;
        let target = match target {
            IsolationTarget::SupervisorCode => SUPERVISOR_CODE,
            IsolationTarget::Pvcs => PVCS,
            IsolationTarget::PageTables => TABLE_BASE,
        };
        image
            .memory
            .write(
                GuestAddress::new(USER_CODE).map_err(PvmImageError::Memory)?,
                &isolation_code(target, access),
            )
            .map_err(PvmImageError::Memory)?;
        Ok(image)
    }

    /// Builds an isolated PVM image from validated ELF load segments.
    ///
    /// # Errors
    ///
    /// Returns [`PvmImageError`] if program ranges overflow, exceed the phase
    /// memory image, overlap runtime pages, or fail checked installation.
    pub fn from_program(abi: PvmAbi, program: &Program) -> Result<Self, PvmImageError> {
        Self::from_program_mode(abi, program, None, ProgramImageMode::Cold, &[], &[])
    }

    /// Builds a bounded Linux process image with the normal startup ABI.
    ///
    /// The image supplies `argc`/`argv`/`envp`, Linux auxiliary-vector entries,
    /// a 32 MiB `brk` arena, and a 1 MiB stack. Writable user pages remain
    /// writable and are retained as the validation plan for host-mediated
    /// syscalls.
    ///
    /// # Errors
    ///
    /// Returns [`PvmImageError`] if the program cannot fit the bounded process
    /// layout or its Linux initial stack cannot be encoded safely.
    pub fn linux_process(
        abi: PvmAbi,
        program: &Program,
        arguments: &[&[u8]],
        environment: &[&[u8]],
    ) -> Result<Self, PvmImageError> {
        Self::from_program_mode(
            abi,
            program,
            None,
            ProgramImageMode::LinuxProcess,
            arguments,
            environment,
        )
    }

    /// Builds a Linux process whose initial entry is a controlled interpreter.
    ///
    /// # Errors
    ///
    /// Returns [`PvmImageError`] if either image overlaps the bounded process
    /// layout or the initial Linux stack cannot be encoded safely.
    pub fn linux_process_with_interpreter(
        abi: PvmAbi,
        program: &Program,
        interpreter: &Program,
        arguments: &[&[u8]],
        environment: &[&[u8]],
    ) -> Result<Self, PvmImageError> {
        Self::from_program_mode(
            abi,
            program,
            Some(interpreter),
            ProgramImageMode::LinuxProcess,
            arguments,
            environment,
        )
    }

    /// Builds and seals a program image for page-fault-driven COW children.
    ///
    /// Every writable user leaf is made read-only in both page-table roots and
    /// retained in an immutable fault lookup plan.
    ///
    /// # Errors
    ///
    /// Returns [`PvmImageError`] under the same checked layout contracts as
    /// [`Self::from_program`].
    pub fn cow_template(abi: PvmAbi, program: &Program) -> Result<Self, PvmImageError> {
        Self::from_program_mode(abi, program, None, ProgramImageMode::SealedCow, &[], &[])
    }

    /// Builds a bounded static-Linux image that remains writable for warm-up.
    ///
    /// The image includes a fixed 32 MiB `brk` arena, a 1 MiB initial stack,
    /// Linux auxiliary-vector metadata, and an unsealed COW plan. It is only
    /// published after the guest reaches the actor checkpoint syscall.
    ///
    /// # Errors
    ///
    /// Returns [`PvmImageError`] if the program cannot fit the bounded actor
    /// layout or the initial Linux stack cannot be encoded safely.
    pub fn actor_warmup(abi: PvmAbi, program: &Program) -> Result<Self, PvmImageError> {
        const ARGUMENTS: &[&[u8]] = &[b"/minisandbox/quickjs-actor"];
        Self::from_program_mode(
            abi,
            program,
            None,
            ProgramImageMode::ActorWarmup,
            ARGUMENTS,
            &[],
        )
    }

    #[allow(clippy::too_many_lines)]
    fn from_program_mode(
        abi: PvmAbi,
        program: &Program,
        interpreter: Option<&Program>,
        mode: ProgramImageMode,
        arguments: &[&[u8]],
        environment: &[&[u8]],
    ) -> Result<Self, PvmImageError> {
        let address = |raw| GuestAddress::new(raw).map_err(PvmImageError::Memory);
        let linux = matches!(
            mode,
            ProgramImageMode::LinuxProcess | ProgramImageMode::ActorWarmup
        );
        let memory_size = if linux {
            ACTOR_MEMORY_SIZE
        } else {
            MEMORY_SIZE
        };
        let table_base = if linux { ACTOR_TABLE_BASE } else { TABLE_BASE };
        let mut plan = PageTablePlan::new();
        for raw in [PVCS, SUPERVISOR_STACK, GDT] {
            let page = address(raw)?;
            plan.map_supervisor(page, page, PagePermissions::READ_WRITE)
                .map_err(PvmImageError::Paging)?;
        }
        let supervisor_code = address(SUPERVISOR_CODE)?;
        plan.map_supervisor(
            supervisor_code,
            supervisor_code,
            PagePermissions::READ_EXECUTE,
        )
        .map_err(PvmImageError::Paging)?;
        let (stack_start, stack_end) = if linux {
            (ACTOR_STACK_START, ACTOR_STACK_END)
        } else {
            (USER_STACK, USER_STACK + PAGE_SIZE_U64)
        };
        for raw in (stack_start..stack_end).step_by(PAGE_SIZE) {
            let page = address(raw)?;
            plan.map_user(page, page, PagePermissions::READ_WRITE)
                .map_err(PvmImageError::Paging)?;
        }
        if linux {
            for raw in (ACTOR_HEAP_START..ACTOR_HEAP_END).step_by(PAGE_SIZE) {
                let page = address(raw)?;
                plan.map_user(page, page, PagePermissions::READ_WRITE)
                    .map_err(PvmImageError::Paging)?;
            }
            for raw in (PROCESS_MMAP_START..PROCESS_MMAP_END).step_by(PAGE_SIZE) {
                let page = address(raw)?;
                plan.map_user(page, page, PagePermissions::READ_WRITE)
                    .map_err(PvmImageError::Paging)?;
            }
        }

        for image_program in [Some(program), interpreter].into_iter().flatten() {
            for segment in image_program.segments() {
                let start = segment.virtual_address().get() & !0xfff;
                let segment_end = segment
                    .virtual_address()
                    .get()
                    .checked_add(segment.memory_size())
                    .ok_or(PvmImageError::ProgramLayout)?;
                let end = segment_end
                    .checked_add(0xfff)
                    .ok_or(PvmImageError::ProgramLayout)?
                    & !0xfff;
                if end > u64::try_from(memory_size).map_err(|_| PvmImageError::ProgramLayout)? {
                    return Err(PvmImageError::ProgramLayout);
                }
                let permissions = match (
                    segment.permissions().is_writable(),
                    segment.permissions().is_executable(),
                ) {
                    (false, false) => PagePermissions::READ_ONLY,
                    (false, true) => PagePermissions::READ_EXECUTE,
                    (true, false) => PagePermissions::READ_WRITE,
                    (true, true) => return Err(PvmImageError::ProgramLayout),
                };
                for raw in (start..end).step_by(PAGE_SIZE) {
                    let page = address(raw)?;
                    plan.map_user(page, page, permissions)
                        .map_err(PvmImageError::Paging)?;
                }
            }
        }

        let mut tables = plan
            .materialize_4k(address(table_base)?)
            .map_err(PvmImageError::Paging)?;
        let cow_pages = match mode {
            ProgramImageMode::Cold => CowPagePlan::default(),
            ProgramImageMode::SealedCow => tables
                .seal_writable_user_pages()
                .map_err(PvmImageError::Paging)?,
            ProgramImageMode::LinuxProcess | ProgramImageMode::ActorWarmup => tables
                .writable_user_page_plan()
                .map_err(PvmImageError::Paging)?,
        };
        if linux {
            for raw in (PROCESS_MMAP_START..PROCESS_MMAP_END).step_by(PAGE_SIZE) {
                let page = cow_pages
                    .page(address(raw)?)
                    .ok_or(PvmImageError::ProgramLayout)?;
                tables
                    .clear_planned_user_page(page)
                    .map_err(PvmImageError::Paging)?;
            }
        }
        let mut memory = GuestMemory::new(memory_size);
        tables.install(&mut memory).map_err(PvmImageError::Memory)?;
        for image_program in [Some(program), interpreter].into_iter().flatten() {
            for segment in image_program.segments() {
                memory
                    .write(segment.virtual_address(), segment.file_bytes())
                    .map_err(PvmImageError::Memory)?;
            }
        }

        let user_rsp = if linux {
            let executable_name = if mode == ProgramImageMode::ActorWarmup {
                ACTOR_EXECUTABLE_NAME
            } else {
                GENERIC_EXECUTABLE_NAME
            };
            install_linux_initial_stack(
                &mut memory,
                program,
                executable_name,
                arguments,
                environment,
                interpreter.map_or(0, Program::load_bias),
            )?
        } else {
            USER_STACK + PAGE_SIZE_U64 - 16
        };
        let frame = PvmUserFrame {
            rip: interpreter.map_or(program.entry(), Program::entry).get(),
            rsp: user_rsp,
            rflags: 0x202,
            rcx: 0,
            r11: 0,
            user_gsbase: 0,
        };
        memory
            .write(address(PVCS)?, PvcsPage::new(abi, frame).as_bytes())
            .map_err(PvmImageError::Memory)?;
        install_runtime_code(&mut memory, abi)?;
        install_gdt(&mut memory)?;

        Ok(Self {
            memory,
            boot: PvmBootConfig {
                abi,
                supervisor_cr3: tables.root(PageRoot::Supervisor).get(),
                user_cr3: tables.root(PageRoot::User).get(),
                pvcs_gpa: PVCS,
                retu_rip: SUPERVISOR_CODE,
                event_entry: EVENT_ENTRY,
                legacy_rets_rip: LEGACY_RETS,
                lstar: LSTAR,
                supervisor_rsp: SUPERVISOR_STACK + PAGE_SIZE_U64,
                user_rsp: frame.rsp,
                gdt_base: GDT,
                gdt_limit: 7 * 8 - 1,
            },
            cow_pages,
            linux_process: linux.then(|| LinuxProcessLayout {
                brk_start: GuestAddress::new(ACTOR_HEAP_START)
                    .expect("actor heap start is canonical"),
                brk_limit: GuestAddress::new(ACTOR_HEAP_END)
                    .expect("actor heap limit is canonical"),
                stack_limit: ACTOR_STACK_END - ACTOR_STACK_START,
                random_seed: GuestAddress::new(ACTOR_STACK_END - 16)
                    .expect("actor random seed address is canonical"),
                mmap_start: GuestAddress::new(PROCESS_MMAP_START)
                    .expect("process mmap start is canonical"),
                mmap_limit: GuestAddress::new(PROCESS_MMAP_END)
                    .expect("process mmap limit is canonical"),
                executable_name: if mode == ProgramImageMode::ActorWarmup {
                    ACTOR_EXECUTABLE_NAME
                } else {
                    GENERIC_EXECUTABLE_NAME
                },
            }),
        })
    }

    /// Borrows the complete guest-physical memory image.
    #[must_use]
    pub fn memory(&self) -> &[u8] {
        self.memory.as_bytes()
    }

    /// Returns the PVM register/MSR boot contract for this image.
    #[must_use]
    pub const fn boot_config(&self) -> PvmBootConfig {
        self.boot
    }

    /// Borrows the sealed writable-page fault lookup plan.
    #[must_use]
    pub const fn cow_pages(&self) -> &CowPagePlan {
        &self.cow_pages
    }

    /// Returns the bounded Linux-process layout for an actor warm-up image.
    #[must_use]
    pub const fn linux_process_layout(&self) -> Option<LinuxProcessLayout> {
        self.linux_process
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProgramImageMode {
    Cold,
    SealedCow,
    LinuxProcess,
    ActorWarmup,
}

fn install_linux_initial_stack(
    memory: &mut GuestMemory,
    program: &Program,
    executable_name: &[u8],
    arguments: &[&[u8]],
    environment: &[&[u8]],
    interpreter_base: u64,
) -> Result<u64, PvmImageError> {
    const PLATFORM: &[u8] = b"x86_64\0";
    const RANDOM_BYTES: [u8; 16] = [
        0x6d, 0x69, 0x6e, 0x69, 0x73, 0x61, 0x6e, 0x64, 0x62, 0x6f, 0x78, 0x2d, 0x70, 0x76, 0x6d,
        0x21,
    ];
    let headers = program
        .program_headers()
        .ok_or(PvmImageError::ProgramLayout)?;
    validate_initial_stack_inputs(arguments, environment)?;
    let mut cursor = ACTOR_STACK_END;
    let mut write_top = |bytes: &[u8]| -> Result<u64, PvmImageError> {
        cursor = cursor
            .checked_sub(u64::try_from(bytes.len()).map_err(|_| PvmImageError::ProgramLayout)?)
            .ok_or(PvmImageError::ProgramLayout)?;
        memory
            .write(
                GuestAddress::new(cursor).map_err(PvmImageError::Memory)?,
                bytes,
            )
            .map_err(PvmImageError::Memory)?;
        Ok(cursor)
    };
    let random_address = write_top(&RANDOM_BYTES)?;
    let platform_address = write_top(PLATFORM)?;
    if executable_name.contains(&0) {
        return Err(PvmImageError::ProgramLayout);
    }
    let mut executable_string = Vec::with_capacity(executable_name.len() + 1);
    executable_string.extend_from_slice(executable_name);
    executable_string.push(0);
    let executable_address = write_top(&executable_string)?;
    let mut argument_addresses = Vec::with_capacity(arguments.len());
    for argument in arguments {
        if argument.contains(&0) {
            return Err(PvmImageError::ProgramLayout);
        }
        let mut string = Vec::with_capacity(argument.len() + 1);
        string.extend_from_slice(argument);
        string.push(0);
        argument_addresses.push(write_top(&string)?);
    }
    let mut environment_addresses = Vec::with_capacity(environment.len());
    for variable in environment {
        if variable.contains(&0) {
            return Err(PvmImageError::ProgramLayout);
        }
        let mut string = Vec::with_capacity(variable.len() + 1);
        string.extend_from_slice(variable);
        string.push(0);
        environment_addresses.push(write_top(&string)?);
    }

    let auxiliary = [
        (3_u64, headers.address().get()),
        (4, u64::from(headers.entry_size())),
        (5, u64::from(headers.count())),
        (6, PAGE_SIZE_U64),
        (7, interpreter_base),
        (8, 0),
        (9, program.entry().get()),
        (11, 0),
        (12, 0),
        (13, 0),
        (14, 0),
        (15, platform_address),
        (16, 0),
        (17, 100),
        (23, 0),
        (25, random_address),
        (26, 0),
        (31, executable_address),
        (0, 0),
    ];
    let mut words = Vec::new();
    words.push(u64::try_from(argument_addresses.len()).map_err(|_| PvmImageError::ProgramLayout)?);
    words.extend(argument_addresses);
    words.push(0); // argv terminator
    words.extend(environment_addresses);
    words.push(0); // envp terminator
    for (kind, value) in auxiliary {
        words.extend([kind, value]);
    }
    let mut bytes = Vec::with_capacity(words.len() * size_of::<u64>());
    for word in words {
        bytes.extend(word.to_le_bytes());
    }
    let stack_pointer = cursor
        .checked_sub(u64::try_from(bytes.len()).map_err(|_| PvmImageError::ProgramLayout)?)
        .ok_or(PvmImageError::ProgramLayout)?
        & !0xf;
    if stack_pointer < ACTOR_STACK_START {
        return Err(PvmImageError::ProgramLayout);
    }
    memory
        .write(
            GuestAddress::new(stack_pointer).map_err(PvmImageError::Memory)?,
            &bytes,
        )
        .map_err(PvmImageError::Memory)?;
    Ok(stack_pointer)
}

fn validate_initial_stack_inputs(
    arguments: &[&[u8]],
    environment: &[&[u8]],
) -> Result<(), PvmImageError> {
    if arguments.len() > MAX_PROCESS_VECTOR_ENTRIES
        || environment.len() > MAX_PROCESS_VECTOR_ENTRIES
    {
        return Err(PvmImageError::ProgramLayout);
    }
    let string_bytes = arguments
        .iter()
        .chain(environment)
        .try_fold(0_usize, |total, value| {
            total.checked_add(value.len().checked_add(1)?)
        })
        .ok_or(PvmImageError::ProgramLayout)?;
    if string_bytes > MAX_PROCESS_STRING_BYTES {
        return Err(PvmImageError::ProgramLayout);
    }
    Ok(())
}

impl PvcsPage {
    /// Encodes a logical user frame according to the selected PVM ABI.
    #[must_use]
    pub fn new(abi: PvmAbi, frame: PvmUserFrame) -> Self {
        let mut bytes = Box::new([0; PAGE_SIZE]);
        match abi {
            PvmAbi::Legacy => encode_fields! {
                &mut bytes,
                0 => LEGACY_EVENT_ENABLE,
                64 => USER_CS,
                66 => USER_SS,
                80 => frame.user_gsbase,
                88 => frame.rflags,
                96 => frame.rip,
                104 => frame.rsp,
                112 => frame.rcx,
                120 => frame.r11,
            },
            PvmAbi::Modern => encode_fields! {
                &mut bytes,
                64 => USER_CS,
                66 => USER_SS,
                70 => MODERN_STANDARD_EVENT_VECTOR,
                72 => frame.user_gsbase,
                80 => frame.rflags,
                88 => frame.rip,
                96 => frame.rcx,
                104 => frame.r11,
            },
        }
        Self { bytes }
    }

    /// Returns the complete zero-padded backing page.
    #[must_use]
    pub fn as_bytes(&self) -> &[u8; PAGE_SIZE] {
        &self.bytes
    }
}

fn put<const LENGTH: usize>(page: &mut [u8; PAGE_SIZE], offset: usize, value: [u8; LENGTH]) {
    page[offset..offset + LENGTH].copy_from_slice(&value);
}

fn install_probe_code(memory: &mut GuestMemory) -> Result<(), PvmImageError> {
    let write = |memory: &mut GuestMemory, raw, code: &[u8]| {
        let address = GuestAddress::new(raw).map_err(PvmImageError::Memory)?;
        memory.write(address, code).map_err(PvmImageError::Memory)
    };

    write(memory, SUPERVISOR_CODE, &[0x0f, 0x05, 0x0f, 0x0b])?;
    write(memory, LSTAR, &io_exit_stub(TRANSITION_MAGIC))?;
    write(memory, EVENT_ENTRY, &io_exit_stub(EVENT_FAILURE_MAGIC))?;
    write(
        memory,
        EVENT_ENTRY + 512,
        &io_exit_stub(EVENT_FAILURE_MAGIC),
    )?;
    write(memory, LEGACY_RETS, &[0x0f, 0x05, 0x0f, 0x0b])?;
    write(memory, USER_CODE, &[0x0f, 0x05, 0x0f, 0x0b])
}

fn install_runtime_code(memory: &mut GuestMemory, abi: PvmAbi) -> Result<(), PvmImageError> {
    let write = |memory: &mut GuestMemory, raw, code: &[u8]| {
        let address = GuestAddress::new(raw).map_err(PvmImageError::Memory)?;
        memory.write(address, code).map_err(PvmImageError::Memory)
    };

    write(memory, SUPERVISOR_CODE, &[0x0f, 0x05, 0x0f, 0x0b])?;
    write(
        memory,
        LSTAR,
        &[
            0xe7, 0x80, // out 0x80, eax
            0xe9, 0xf9, 0xfe, 0xff, 0xff, // jmp MSR_RETU_RIP
            0x0f, 0x0b, // ud2 if the jump is corrupted
        ],
    )?;
    write(
        memory,
        EVENT_ENTRY,
        &pvm_event_stub(abi, EVENT_ENTRY, SUPERVISOR_CODE),
    )?;
    write(
        memory,
        EVENT_ENTRY + 512,
        &pvm_event_stub(abi, EVENT_ENTRY + 512, SUPERVISOR_CODE),
    )?;
    write(memory, LEGACY_RETS, &[0x0f, 0x05, 0x0f, 0x0b])
}

fn pvm_event_stub(abi: PvmAbi, stub_address: u64, retu_address: u64) -> Vec<u8> {
    let mut code = vec![0x50, 0x52, 0x57]; // push rax; push rdx; push rdi
    match abi {
        PvmAbi::Legacy => {
            code.extend([0x65, 0x48, 0x8b, 0x3c, 0x25, 16, 0, 0, 0]); // mov rdi, gs:[16]
            code.extend([0x65, 0x8b, 0x04, 0x25, 8, 0, 0, 0]); // mov eax, gs:[8]
            code.extend([0x65, 0x8b, 0x14, 0x25, 12, 0, 0, 0]); // mov edx, gs:[12]
        }
        PvmAbi::Modern => {
            code.extend([0x65, 0x48, 0x8b, 0x3c, 0x25, 8, 0, 0, 0]); // mov rdi, gs:[8]
            code.extend([0x65, 0x0f, 0xb7, 0x04, 0x25, 68, 0, 0, 0]); // movzx eax, gs:[68]
            code.extend([0x65, 0x0f, 0xb7, 0x14, 0x25, 70, 0, 0, 0]); // movzx edx, gs:[70]
        }
    }
    code.extend([0x81, 0xe2, 0xff, 0, 0, 0]); // and edx, 0xff
    code.extend([0x81, 0xc2]); // add edx, event port base
    code.extend(u32::from(PVM_EVENT_PORT_BASE).to_le_bytes());
    code.push(0xef); // out dx, eax
    code.extend([0x53, 0x41, 0x52, 0x41, 0x53]); // save hypercall scratch registers
    code.extend([0x48, 0x89, 0xfb]); // mov rbx, rdi
    code.extend([0xb8, 0x05, 0x82, 0x08, 0x17]); // mov eax, HC_TLB_INVLPG
    code.extend([0x0f, 0x05]); // PVM supervisor hypercall
    code.extend([0x41, 0x5b, 0x41, 0x5a, 0x5b]); // restore r11, r10, rbx
    code.extend([0x5f, 0x5a, 0x58]); // pop rdi; pop rdx; pop rax
    match abi {
        PvmAbi::Legacy => {
            code.extend([0x65, 0x48, 0x83, 0x0c, 0x25, 0, 0, 0, 0, 1]); // or qword gs:[0], 1
        }
        PvmAbi::Modern => {
            code.extend([0x65, 0x66, 0xc7, 0x04, 0x25, 70, 0, 0, 0, 0, 1]); // vector = STD
        }
    }
    let next = stub_address
        .checked_add(u64::try_from(code.len() + 5).expect("event stub length fits u64"))
        .expect("event stub address remains canonical");
    let displacement = i32::try_from(i128::from(retu_address) - i128::from(next))
        .expect("event-to-ERETU jump fits rel32");
    code.push(0xe9);
    code.extend(displacement.to_le_bytes());
    code
}

fn install_gdt(memory: &mut GuestMemory) -> Result<(), PvmImageError> {
    let descriptors: [u64; 7] = [
        0,
        0x00af_9a00_0000_ffff,
        0x00cf_9200_0000_ffff,
        0,
        0x00cf_fa00_0000_ffff,
        0x00cf_f200_0000_ffff,
        0x00af_fa00_0000_ffff,
    ];
    let mut bytes = [0_u8; 7 * 8];
    for (index, descriptor) in descriptors.into_iter().enumerate() {
        let start = index * 8;
        bytes[start..start + 8].copy_from_slice(&descriptor.to_le_bytes());
    }
    memory
        .write(
            GuestAddress::new(GDT).map_err(PvmImageError::Memory)?,
            &bytes,
        )
        .map_err(PvmImageError::Memory)
}

fn io_exit_stub(value: u32) -> [u8; 8] {
    let value = value.to_le_bytes();
    [
        0xb8, value[0], value[1], value[2], value[3], 0xe7, 0xe9, 0xf4,
    ]
}

fn isolation_code(target: u64, access: IsolationAccess) -> [u8; 15] {
    let target = target.to_le_bytes();
    let operation = match access {
        IsolationAccess::Read => 0x8b,
        IsolationAccess::Write => 0x89,
    };
    [
        0x48, 0xb8, target[0], target[1], target[2], target[3], target[4], target[5], target[6],
        target[7], 0x48, operation, 0x00, 0x0f, 0x05,
    ]
}
