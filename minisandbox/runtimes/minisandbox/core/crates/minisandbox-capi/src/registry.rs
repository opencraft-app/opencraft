//! Process-local, generation-checked C ABI object registry.

use std::{
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use minisandbox_core::{engine::Template, program::Program};

use crate::{Handle, Status};

const SLOT_BITS: u32 = 20;
const GENERATION_BITS: u32 = 20;
const KIND_BITS: u32 = 8;
const SLOT_MASK: u64 = (1 << SLOT_BITS) - 1;
const GENERATION_MASK: u32 = (1 << GENERATION_BITS) - 1;
const GENERATION_SHIFT: u32 = SLOT_BITS;
const KIND_SHIFT: u32 = SLOT_BITS + GENERATION_BITS;
const COOKIE_SHIFT: u32 = SLOT_BITS + GENERATION_BITS + KIND_BITS;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
enum ObjectKind {
    Runtime = 1,
    Program = 2,
    Template = 3,
    Instance = 4,
}

#[derive(Debug)]
enum StoredObject {
    Runtime,
    Program { program: Program },
    Template { template: Arc<Template> },
    Instance { instance: Arc<InstanceRecord> },
}

impl StoredObject {
    const fn kind(&self) -> ObjectKind {
        match self {
            Self::Runtime => ObjectKind::Runtime,
            Self::Program { .. } => ObjectKind::Program,
            Self::Template { .. } => ObjectKind::Template,
            Self::Instance { .. } => ObjectKind::Instance,
        }
    }
}

#[derive(Debug)]
struct Slot {
    generation: u32,
    object: Option<StoredObject>,
}

#[derive(Debug)]
struct Registry {
    pid: u32,
    cookie: u16,
    slots: Vec<Slot>,
}

static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();

pub(crate) fn insert_runtime() -> Result<Handle, Status> {
    with_registry(|registry| registry.insert(StoredObject::Runtime))
}

pub(crate) fn release(handle: Handle) -> Result<(), Status> {
    with_registry(|registry| registry.release(handle))
}

pub(crate) fn insert_program(runtime: Handle, program: Program) -> Result<Handle, Status> {
    with_registry(|registry| {
        registry.require_kind(runtime, ObjectKind::Runtime)?;
        registry.insert(StoredObject::Program { program })
    })
}

pub(crate) fn insert_instance(runtime: Handle, program: Handle) -> Result<Handle, Status> {
    with_registry(|registry| {
        registry.require_kind(runtime, ObjectKind::Runtime)?;
        let program = registry.clone_program(program)?;
        registry.insert(StoredObject::Instance {
            instance: Arc::new(InstanceRecord::new(InstanceSource::Program(program))),
        })
    })
}

pub(crate) fn program_for_template(runtime: Handle, program: Handle) -> Result<Program, Status> {
    with_registry(|registry| {
        registry.require_kind(runtime, ObjectKind::Runtime)?;
        registry.clone_program(program)
    })
}

pub(crate) fn insert_template(runtime: Handle, template: Template) -> Result<Handle, Status> {
    with_registry(|registry| {
        registry.require_kind(runtime, ObjectKind::Runtime)?;
        registry.insert(StoredObject::Template {
            template: Arc::new(template),
        })
    })
}

pub(crate) fn insert_cow_instance(runtime: Handle, template: Handle) -> Result<Handle, Status> {
    with_registry(|registry| {
        registry.require_kind(runtime, ObjectKind::Runtime)?;
        let template = registry.clone_template(template)?;
        registry.insert(StoredObject::Instance {
            instance: Arc::new(InstanceRecord::new(InstanceSource::Template(template))),
        })
    })
}

pub(crate) fn instance(handle: Handle) -> Result<Arc<InstanceRecord>, Status> {
    with_registry(|registry| registry.clone_instance(handle))
}

fn registry() -> &'static Mutex<Registry> {
    REGISTRY.get_or_init(|| Mutex::new(Registry::new()))
}

fn with_registry<T>(
    operation: impl FnOnce(&mut Registry) -> Result<T, Status>,
) -> Result<T, Status> {
    let mut registry = registry()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    registry.refresh_after_fork();
    operation(&mut registry)
}

impl Registry {
    fn new() -> Self {
        Self {
            pid: std::process::id(),
            cookie: process_cookie(),
            slots: Vec::new(),
        }
    }

    fn refresh_after_fork(&mut self) {
        let pid = std::process::id();
        if self.pid != pid {
            self.pid = pid;
            self.cookie = process_cookie();
            self.slots.clear();
        }
    }

    fn insert(&mut self, object: StoredObject) -> Result<Handle, Status> {
        let index = if let Some(index) = self.slots.iter().position(|slot| slot.object.is_none()) {
            index
        } else {
            if self.slots.len() >= usize::try_from(SLOT_MASK).map_err(|_| Status::Internal)? {
                return Err(Status::Internal);
            }
            self.slots.push(Slot {
                generation: 1,
                object: None,
            });
            self.slots.len() - 1
        };
        let slot = &mut self.slots[index];
        let kind = object.kind();
        slot.object = Some(object);
        encode(self.cookie, kind, slot.generation, index)
    }

    fn release(&mut self, handle: Handle) -> Result<(), Status> {
        let (index, _) = self.validate_handle(handle)?;
        let slot = &mut self.slots[index];
        slot.object = None;
        slot.generation = next_generation(slot.generation);
        Ok(())
    }

    fn require_kind(&self, handle: Handle, expected: ObjectKind) -> Result<(), Status> {
        let (_, actual) = self.validate_handle(handle)?;
        if actual == expected {
            Ok(())
        } else {
            Err(Status::WrongHandleKind)
        }
    }

    fn clone_program(&self, handle: Handle) -> Result<Program, Status> {
        let (index, kind) = self.validate_handle(handle)?;
        if kind != ObjectKind::Program {
            return Err(Status::WrongHandleKind);
        }
        match self.slots[index].object.as_ref() {
            Some(StoredObject::Program { program }) => Ok(program.clone()),
            _ => Err(Status::Internal),
        }
    }

    fn clone_instance(&self, handle: Handle) -> Result<Arc<InstanceRecord>, Status> {
        let (index, kind) = self.validate_handle(handle)?;
        if kind != ObjectKind::Instance {
            return Err(Status::WrongHandleKind);
        }
        match self.slots[index].object.as_ref() {
            Some(StoredObject::Instance { instance }) => Ok(Arc::clone(instance)),
            _ => Err(Status::Internal),
        }
    }

    fn clone_template(&self, handle: Handle) -> Result<Arc<Template>, Status> {
        let (index, kind) = self.validate_handle(handle)?;
        if kind != ObjectKind::Template {
            return Err(Status::WrongHandleKind);
        }
        match self.slots[index].object.as_ref() {
            Some(StoredObject::Template { template }) => Ok(Arc::clone(template)),
            _ => Err(Status::Internal),
        }
    }

    fn validate_handle(&self, handle: Handle) -> Result<(usize, ObjectKind), Status> {
        let decoded = decode(handle).ok_or(Status::InvalidHandle)?;
        if decoded.cookie != self.cookie {
            return Err(Status::InvalidHandle);
        }
        let slot = self.slots.get(decoded.index).ok_or(Status::InvalidHandle)?;
        if slot.generation != decoded.generation {
            return Err(Status::InvalidHandle);
        }
        let object = slot.object.as_ref().ok_or(Status::InvalidHandle)?;
        if object.kind() as u8 != decoded.kind {
            return Err(Status::WrongHandleKind);
        }
        Ok((decoded.index, object.kind()))
    }
}

#[derive(Debug)]
pub(crate) struct InstanceRecord {
    source: InstanceSource,
    busy: AtomicBool,
    consumed: AtomicBool,
    last_exit: Mutex<Option<i32>>,
    last_dirty_pages: Mutex<Option<usize>>,
}

#[derive(Debug)]
pub(crate) enum InstanceSource {
    Program(Program),
    Template(Arc<Template>),
}

impl InstanceRecord {
    fn new(source: InstanceSource) -> Self {
        Self {
            source,
            busy: AtomicBool::new(false),
            consumed: AtomicBool::new(false),
            last_exit: Mutex::new(None),
            last_dirty_pages: Mutex::new(None),
        }
    }

    pub(crate) fn begin_run(self: &Arc<Self>) -> Result<InstanceRunGuard, Status> {
        self.busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| Status::Busy)?;
        if matches!(self.source, InstanceSource::Template(_))
            && self.consumed.swap(true, Ordering::AcqRel)
        {
            self.busy.store(false, Ordering::Release);
            return Err(Status::InvalidArgument);
        }
        Ok(InstanceRunGuard {
            instance: Arc::clone(self),
        })
    }

    pub(crate) fn requires_turn_input(&self) -> bool {
        matches!(
            &self.source,
            InstanceSource::Template(template) if template.is_actor_template()
        )
    }

    pub(crate) fn accepts_process_input(&self) -> bool {
        matches!(self.source, InstanceSource::Program(_))
    }

    pub(crate) fn exit_code(&self) -> Option<i32> {
        *self
            .last_exit
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub(crate) fn dirty_pages(&self) -> Option<usize> {
        *self
            .last_dirty_pages
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

pub(crate) struct InstanceRunGuard {
    instance: Arc<InstanceRecord>,
}

impl InstanceRunGuard {
    pub(crate) fn source(&self) -> &InstanceSource {
        &self.instance.source
    }

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    pub(crate) fn set_exit_code(&self, exit_code: Option<i32>) {
        *self
            .instance
            .last_exit
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = exit_code;
    }

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    pub(crate) fn set_dirty_pages(&self, dirty_pages: Option<usize>) {
        *self
            .instance
            .last_dirty_pages
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = dirty_pages;
    }
}

impl Drop for InstanceRunGuard {
    fn drop(&mut self) {
        self.instance.busy.store(false, Ordering::Release);
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct DecodedHandle {
    cookie: u16,
    kind: u8,
    generation: u32,
    index: usize,
}

fn encode(cookie: u16, kind: ObjectKind, generation: u32, index: usize) -> Result<Handle, Status> {
    let encoded_index = u64::try_from(index)
        .map_err(|_| Status::Internal)?
        .checked_add(1)
        .ok_or(Status::Internal)?;
    if encoded_index > SLOT_MASK || generation == 0 || generation > GENERATION_MASK {
        return Err(Status::Internal);
    }
    Ok((u64::from(cookie) << COOKIE_SHIFT)
        | (u64::from(kind as u8) << KIND_SHIFT)
        | (u64::from(generation) << GENERATION_SHIFT)
        | encoded_index)
}

fn decode(handle: Handle) -> Option<DecodedHandle> {
    let encoded_index = handle & SLOT_MASK;
    let generation =
        u32::try_from((handle >> GENERATION_SHIFT) & u64::from(GENERATION_MASK)).ok()?;
    if handle == 0 || encoded_index == 0 || generation == 0 {
        return None;
    }
    Some(DecodedHandle {
        cookie: (handle >> COOKIE_SHIFT) as u16,
        kind: ((handle >> KIND_SHIFT) & ((1 << KIND_BITS) - 1)) as u8,
        generation,
        index: usize::try_from(encoded_index - 1).ok()?,
    })
}

const fn next_generation(generation: u32) -> u32 {
    let next = generation.wrapping_add(1) & GENERATION_MASK;
    if next == 0 { 1 } else { next }
}

fn process_cookie() -> u16 {
    let stack_marker = 0_u8;
    let address = std::ptr::addr_of!(stack_marker).addr() as u64;
    let time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            let nanos = duration.as_nanos();
            let low = u64::try_from(nanos & u128::from(u64::MAX)).unwrap_or(0);
            let high = u64::try_from(nanos >> u64::BITS).unwrap_or(0);
            low ^ high
        });
    let mixed = address ^ time ^ u64::from(std::process::id());
    let folded = mixed ^ (mixed >> 16) ^ (mixed >> 32) ^ (mixed >> 48);
    u16::try_from(folded & u64::from(u16::MAX)).unwrap_or(1) | 1
}
