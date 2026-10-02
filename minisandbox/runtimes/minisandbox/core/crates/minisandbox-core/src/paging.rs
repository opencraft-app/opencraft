//! Safe semantic plan for isolated `x86_64` page-table roots.

use std::collections::BTreeMap;

use crate::memory::{GuestAddress, GuestMemory, MemoryError};

const PAGE_MASK: u64 = 4095;
const PAGE_BYTES: usize = 4096;
const PAGE_SIZE: u64 = 4096;
const X86_PTE_ADDRESS_MASK: u64 = 0x000f_ffff_ffff_f000;

/// x86 page-table present bit.
pub const X86_PTE_PRESENT: u64 = 1;
/// x86 page-table writable bit.
pub const X86_PTE_WRITABLE: u64 = 1 << 1;
/// x86 page-table user-accessible bit.
pub const X86_PTE_USER: u64 = 1 << 2;
/// x86 page-table no-execute bit.
pub const X86_PTE_NO_EXECUTE: u64 = 1 << 63;

macro_rules! permission_sets {
    ($($(#[$meta:meta])* $name:ident = $bits:expr;)+) => {
        impl PagePermissions {
            $ (
                $(#[$meta])*
                pub const $name: Self = Self($bits);
            )+
        }
    };
}

/// Semantic access permissions for one guest page.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PagePermissions(u8);

permission_sets! {
    /// Readable, but neither writable nor executable.
    READ_ONLY = 0b001;
    /// Readable and executable, but not writable.
    READ_EXECUTE = 0b101;
    /// Readable and writable, but not executable.
    READ_WRITE = 0b011;
    /// Readable, writable, and executable; represented so policy can reject it.
    READ_WRITE_EXECUTE = 0b111;
}

/// Which page-table root performs a translation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PageRoot {
    /// PVM supervisor address space.
    Supervisor,
    /// Sandboxed user address space.
    User,
}

/// A resolved semantic page translation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Translation {
    /// Guest-physical page address.
    pub physical: GuestAddress,
    /// Semantic access permissions.
    pub permissions: PagePermissions,
    user_accessible: bool,
}

/// Failure while constructing a page-table plan.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PagingError {
    /// A virtual or guest-physical address is not 4 KiB aligned.
    Unaligned,
    /// The virtual page already has a mapping in a destination root.
    Overlap,
    /// A mapping requested write and execute permission together.
    WritableExecutable,
    /// Sequential table-page allocation exhausted canonical guest addresses.
    AddressSpaceExhausted,
    /// A materialized tree no longer matches the mapping plan that built it.
    InvalidMaterializedTree,
}

/// Independent supervisor and user mapping plans.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PageTablePlan {
    supervisor: BTreeMap<GuestAddress, Translation>,
    user: BTreeMap<GuestAddress, Translation>,
}

impl PageTablePlan {
    /// Creates an empty pair of roots.
    #[must_use]
    pub const fn new() -> Self {
        Self {
            supervisor: BTreeMap::new(),
            user: BTreeMap::new(),
        }
    }

    /// Adds one supervisor-only page.
    ///
    /// # Errors
    ///
    /// Reserved for invalid mapping contracts added by the next test-first
    /// slice; valid single-page mappings currently succeed.
    pub fn map_supervisor(
        &mut self,
        virtual_address: GuestAddress,
        physical: GuestAddress,
        permissions: PagePermissions,
    ) -> Result<(), PagingError> {
        validate_alignment(virtual_address, physical)?;
        validate_permissions(permissions)?;
        if self.supervisor.contains_key(&virtual_address) {
            return Err(PagingError::Overlap);
        }
        self.supervisor.insert(
            virtual_address,
            Translation {
                physical,
                permissions,
                user_accessible: false,
            },
        );
        Ok(())
    }

    /// Adds one user page to both the supervisor and user roots.
    ///
    /// # Errors
    ///
    /// Reserved for invalid mapping contracts added by the next test-first
    /// slice; valid single-page mappings currently succeed.
    pub fn map_user(
        &mut self,
        virtual_address: GuestAddress,
        physical: GuestAddress,
        permissions: PagePermissions,
    ) -> Result<(), PagingError> {
        validate_alignment(virtual_address, physical)?;
        validate_permissions(permissions)?;
        if self.supervisor.contains_key(&virtual_address)
            || self.user.contains_key(&virtual_address)
        {
            return Err(PagingError::Overlap);
        }
        let translation = Translation {
            physical,
            permissions,
            user_accessible: true,
        };
        self.supervisor.insert(virtual_address, translation);
        self.user.insert(virtual_address, translation);
        Ok(())
    }

    /// Resolves one page-aligned virtual address in the selected root.
    #[must_use]
    pub fn translate(&self, root: PageRoot, virtual_address: GuestAddress) -> Option<Translation> {
        match root {
            PageRoot::Supervisor => self.supervisor.get(&virtual_address),
            PageRoot::User => self.user.get(&virtual_address),
        }
        .copied()
    }

    /// Materializes mappings as independent four-level, 4 KiB page tables.
    ///
    /// Table pages are allocated sequentially from `table_base`. Intermediate
    /// levels are created only for paths used by the plan.
    ///
    /// # Errors
    ///
    /// Returns [`PagingError::Unaligned`] for an unaligned table base and
    /// [`PagingError::AddressSpaceExhausted`] if table-page allocation crosses
    /// the supported canonical-address boundary.
    pub fn materialize_4k(&self, table_base: GuestAddress) -> Result<PageTableImage, PagingError> {
        if table_base.get() & PAGE_MASK != 0 {
            return Err(PagingError::Unaligned);
        }

        let mut builder = PageTableImageBuilder::new(table_base);
        let supervisor_root = builder.build_root(&self.supervisor)?;
        let user_root = builder.build_root(&self.user)?;
        Ok(PageTableImage {
            pages: builder.pages,
            supervisor_root,
            user_root,
            writable_user_pages: self
                .user
                .iter()
                .filter(|(_, translation)| translation.permissions.is_writable())
                .map(|(&virtual_address, translation)| (virtual_address, translation.physical))
                .collect(),
        })
    }
}

impl PagePermissions {
    const fn is_writable(self) -> bool {
        self.0 & 0b010 != 0
    }
}

/// One writable user mapping sealed for copy-on-write handling.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CowPage {
    virtual_address: GuestAddress,
    physical_address: GuestAddress,
    supervisor_leaf_entry: GuestAddress,
    user_leaf_entry: GuestAddress,
}

impl CowPage {
    /// Returns the page-aligned guest virtual address that can fault.
    #[must_use]
    pub const fn virtual_address(self) -> GuestAddress {
        self.virtual_address
    }

    /// Returns the page-aligned guest-physical backing address.
    #[must_use]
    pub const fn physical_address(self) -> GuestAddress {
        self.physical_address
    }

    /// Returns the guest-physical address of the supervisor leaf PTE.
    #[must_use]
    pub const fn supervisor_leaf_entry_address(self) -> GuestAddress {
        self.supervisor_leaf_entry
    }

    /// Returns the guest-physical address of the user leaf PTE.
    #[must_use]
    pub const fn user_leaf_entry_address(self) -> GuestAddress {
        self.user_leaf_entry
    }
}

/// Immutable lookup contract for user pages sealed as copy-on-write.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct CowPagePlan {
    pages: BTreeMap<GuestAddress, CowPage>,
}

impl CowPagePlan {
    /// Returns the number of writable data pages in the sealed template.
    #[must_use]
    pub fn len(&self) -> usize {
        self.pages.len()
    }

    /// Returns whether the template has no copy-on-write data pages.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.pages.is_empty()
    }

    /// Looks up a page-aligned virtual address.
    #[must_use]
    pub fn page(&self, virtual_address: GuestAddress) -> Option<CowPage> {
        self.pages.get(&virtual_address).copied()
    }

    /// Looks up the page containing an arbitrary canonical virtual address.
    #[must_use]
    pub fn page_containing(&self, virtual_address: GuestAddress) -> Option<CowPage> {
        let page = GuestAddress::new(virtual_address.get() & !PAGE_MASK).ok()?;
        self.page(page)
    }

    /// Iterates over all sealed pages in ascending virtual-address order.
    pub fn pages(&self) -> impl Iterator<Item = CowPage> + '_ {
        self.pages.values().copied()
    }

    /// Removes one page from the write-fault COW contract.
    pub fn remove(&mut self, virtual_address: GuestAddress) -> Option<CowPage> {
        self.pages.remove(&virtual_address)
    }
}

/// Materialized four-level x86 page-table pages and roots.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PageTableImage {
    pages: BTreeMap<GuestAddress, Box<[u8; PAGE_BYTES]>>,
    supervisor_root: GuestAddress,
    user_root: GuestAddress,
    writable_user_pages: BTreeMap<GuestAddress, GuestAddress>,
}

impl PageTableImage {
    /// Returns the guest-physical PML4 address for a root.
    #[must_use]
    pub const fn root(&self, root: PageRoot) -> GuestAddress {
        match root {
            PageRoot::Supervisor => self.supervisor_root,
            PageRoot::User => self.user_root,
        }
    }

    /// Installs every table page through checked guest-memory writes.
    ///
    /// # Errors
    ///
    /// Returns [`MemoryError::OutOfBounds`] if any complete table page lies
    /// outside the destination allocation.
    pub fn install(&self, memory: &mut GuestMemory) -> Result<(), MemoryError> {
        for (&address, page) in &self.pages {
            memory.write(address, page.as_slice())?;
        }
        Ok(())
    }

    /// Removes write permission from every writable user leaf in both roots.
    ///
    /// The returned plan retains the exact leaf-entry addresses so a child can
    /// make only its own page-table copies writable after a validated fault.
    ///
    /// # Errors
    ///
    /// Returns [`PagingError::InvalidMaterializedTree`] if the materialized
    /// entries no longer correspond to the immutable source mapping plan.
    pub fn seal_writable_user_pages(&mut self) -> Result<CowPagePlan, PagingError> {
        let plan = self.writable_user_page_plan()?;
        for page in plan.pages() {
            self.clear_entry_bits(page.supervisor_leaf_entry, X86_PTE_WRITABLE)?;
            self.clear_entry_bits(page.user_leaf_entry, X86_PTE_WRITABLE)?;
        }
        Ok(plan)
    }

    /// Captures writable user leaves without changing their permissions.
    ///
    /// This is used by a live warm-up VM that must remain writable until it
    /// reaches a quiescent checkpoint boundary.
    ///
    /// # Errors
    ///
    /// Returns [`PagingError::InvalidMaterializedTree`] if the materialized
    /// entries no longer correspond to the immutable source mapping plan.
    pub fn writable_user_page_plan(&self) -> Result<CowPagePlan, PagingError> {
        let mut pages = BTreeMap::new();
        for (&virtual_address, &physical_address) in &self.writable_user_pages {
            let supervisor_leaf_entry = self
                .leaf_entry_address(PageRoot::Supervisor, virtual_address)
                .ok_or(PagingError::InvalidMaterializedTree)?;
            let user_leaf_entry = self
                .leaf_entry_address(PageRoot::User, virtual_address)
                .ok_or(PagingError::InvalidMaterializedTree)?;
            pages.insert(
                virtual_address,
                CowPage {
                    virtual_address,
                    physical_address,
                    supervisor_leaf_entry,
                    user_leaf_entry,
                },
            );
        }
        Ok(CowPagePlan { pages })
    }

    /// Clears one planned writable user leaf from both roots while retaining
    /// its materialized page-table slot for bounded runtime activation.
    ///
    /// # Errors
    ///
    /// Returns [`PagingError::InvalidMaterializedTree`] if either leaf does not
    /// belong to this materialized mapping plan.
    pub fn clear_planned_user_page(&mut self, page: CowPage) -> Result<(), PagingError> {
        self.clear_entry_bits(
            page.supervisor_leaf_entry,
            X86_PTE_PRESENT | X86_PTE_WRITABLE,
        )?;
        self.clear_entry_bits(page.user_leaf_entry, X86_PTE_PRESENT | X86_PTE_WRITABLE)
    }

    /// Walks the materialized tables and returns a present 4 KiB leaf entry.
    #[must_use]
    pub fn leaf_entry(&self, root: PageRoot, virtual_address: GuestAddress) -> Option<u64> {
        let indices = page_indices(virtual_address);
        let mut table = self.root(root);
        for index in &indices[..3] {
            let entry = self.read_entry(table, *index)?;
            if entry & X86_PTE_PRESENT == 0 {
                return None;
            }
            table = GuestAddress::new(entry & X86_PTE_ADDRESS_MASK).ok()?;
        }
        let leaf = self.read_entry(table, indices[3])?;
        (leaf & X86_PTE_PRESENT != 0).then_some(leaf)
    }

    fn read_entry(&self, table: GuestAddress, index: usize) -> Option<u64> {
        let page = self.pages.get(&table)?;
        let start = index.checked_mul(size_of::<u64>())?;
        let bytes: [u8; 8] = page.get(start..start + 8)?.try_into().ok()?;
        Some(u64::from_le_bytes(bytes))
    }

    fn leaf_entry_address(
        &self,
        root: PageRoot,
        virtual_address: GuestAddress,
    ) -> Option<GuestAddress> {
        let indices = page_indices(virtual_address);
        let mut table = self.root(root);
        for index in &indices[..3] {
            let entry = self.read_entry(table, *index)?;
            if entry & X86_PTE_PRESENT == 0 {
                return None;
            }
            table = GuestAddress::new(entry & X86_PTE_ADDRESS_MASK).ok()?;
        }
        table
            .checked_add(u64::try_from(indices[3].checked_mul(size_of::<u64>())?).ok()?)
            .ok()
    }

    fn clear_entry_bits(
        &mut self,
        entry_address: GuestAddress,
        bits: u64,
    ) -> Result<(), PagingError> {
        let table_address = GuestAddress::new(entry_address.get() & !PAGE_MASK)
            .map_err(|_| PagingError::InvalidMaterializedTree)?;
        let offset = usize::try_from(entry_address.get() & PAGE_MASK)
            .map_err(|_| PagingError::InvalidMaterializedTree)?;
        let table = self
            .pages
            .get_mut(&table_address)
            .ok_or(PagingError::InvalidMaterializedTree)?;
        let bytes = table
            .get(offset..offset + size_of::<u64>())
            .ok_or(PagingError::InvalidMaterializedTree)?;
        let entry = u64::from_le_bytes(
            bytes
                .try_into()
                .map_err(|_| PagingError::InvalidMaterializedTree)?,
        ) & !bits;
        table[offset..offset + size_of::<u64>()].copy_from_slice(&entry.to_le_bytes());
        Ok(())
    }
}

struct PageTableImageBuilder {
    pages: BTreeMap<GuestAddress, Box<[u8; PAGE_BYTES]>>,
    next_page: GuestAddress,
}

impl PageTableImageBuilder {
    fn new(table_base: GuestAddress) -> Self {
        Self {
            pages: BTreeMap::new(),
            next_page: table_base,
        }
    }

    fn build_root(
        &mut self,
        mappings: &BTreeMap<GuestAddress, Translation>,
    ) -> Result<GuestAddress, PagingError> {
        let root = self.allocate_page()?;
        for (&virtual_address, &translation) in mappings {
            let indices = page_indices(virtual_address);
            let mut table = root;
            for index in &indices[..3] {
                table = self.ensure_child(table, *index)?;
            }
            self.write_entry(table, indices[3], leaf_entry(translation));
        }
        Ok(root)
    }

    fn allocate_page(&mut self) -> Result<GuestAddress, PagingError> {
        let allocated = self.next_page;
        self.next_page = allocated
            .checked_add(PAGE_SIZE)
            .map_err(|_| PagingError::AddressSpaceExhausted)?;
        self.pages.insert(allocated, Box::new([0; PAGE_BYTES]));
        Ok(allocated)
    }

    fn ensure_child(
        &mut self,
        parent: GuestAddress,
        index: usize,
    ) -> Result<GuestAddress, PagingError> {
        let existing = self.read_entry(parent, index);
        if existing & X86_PTE_PRESENT != 0 {
            return GuestAddress::new(existing & X86_PTE_ADDRESS_MASK)
                .map_err(|_| PagingError::AddressSpaceExhausted);
        }

        let child = self.allocate_page()?;
        self.write_entry(
            parent,
            index,
            child.get() | X86_PTE_PRESENT | X86_PTE_WRITABLE | X86_PTE_USER,
        );
        Ok(child)
    }

    fn read_entry(&self, table: GuestAddress, index: usize) -> u64 {
        let page = self
            .pages
            .get(&table)
            .expect("builder table addresses always refer to allocated pages");
        let start = index * size_of::<u64>();
        u64::from_le_bytes(
            page[start..start + 8]
                .try_into()
                .expect("one page-table entry is eight bytes"),
        )
    }

    fn write_entry(&mut self, table: GuestAddress, index: usize, entry: u64) {
        let page = self
            .pages
            .get_mut(&table)
            .expect("builder table addresses always refer to allocated pages");
        let start = index * size_of::<u64>();
        page[start..start + 8].copy_from_slice(&entry.to_le_bytes());
    }
}

const fn page_indices(address: GuestAddress) -> [usize; 4] {
    let address = address.get();
    [
        ((address >> 39) & 511) as usize,
        ((address >> 30) & 511) as usize,
        ((address >> 21) & 511) as usize,
        ((address >> 12) & 511) as usize,
    ]
}

const fn leaf_entry(translation: Translation) -> u64 {
    const WRITE: u8 = 0b010;
    const EXECUTE: u8 = 0b100;

    let mut entry = translation.physical.get() | X86_PTE_PRESENT;
    if translation.permissions.0 & WRITE != 0 {
        entry |= X86_PTE_WRITABLE;
    }
    if translation.user_accessible {
        entry |= X86_PTE_USER;
    }
    if translation.permissions.0 & EXECUTE == 0 {
        entry |= X86_PTE_NO_EXECUTE;
    }
    entry
}

const fn validate_permissions(permissions: PagePermissions) -> Result<(), PagingError> {
    const WRITE: u8 = 0b010;
    const EXECUTE: u8 = 0b100;

    if permissions.0 & WRITE != 0 && permissions.0 & EXECUTE != 0 {
        Err(PagingError::WritableExecutable)
    } else {
        Ok(())
    }
}

const fn validate_alignment(
    virtual_address: GuestAddress,
    physical: GuestAddress,
) -> Result<(), PagingError> {
    if virtual_address.get() & PAGE_MASK == 0 && physical.get() & PAGE_MASK == 0 {
        Ok(())
    } else {
        Err(PagingError::Unaligned)
    }
}
