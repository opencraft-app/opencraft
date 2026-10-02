//! Isolated `x86_64` page-table planning contracts.

use minisandbox_core::{
    memory::{GuestAddress, GuestMemory},
    paging::{
        PagePermissions, PageRoot, PageTablePlan, PagingError, X86_PTE_PRESENT, X86_PTE_USER,
        X86_PTE_WRITABLE,
    },
};

#[test]
fn user_root_excludes_supervisor_pages_but_supervisor_can_reach_user_pages() {
    let mut tables = PageTablePlan::new();
    let trampoline = GuestAddress::new(0x1000).expect("canonical trampoline address");
    let user_code = GuestAddress::new(0x40_0000).expect("canonical user-code address");

    tables
        .map_supervisor(trampoline, trampoline, PagePermissions::READ_EXECUTE)
        .expect("the supervisor trampoline mapping is valid");
    tables
        .map_user(user_code, user_code, PagePermissions::READ_EXECUTE)
        .expect("the user-code mapping is valid");

    assert!(tables.translate(PageRoot::User, trampoline).is_none());
    assert_eq!(
        tables
            .translate(PageRoot::Supervisor, user_code)
            .expect("the supervisor root can inspect user code")
            .physical,
        user_code
    );
    assert_eq!(
        tables
            .translate(PageRoot::User, user_code)
            .expect("the user root maps user code")
            .permissions,
        PagePermissions::READ_EXECUTE
    );
}

#[test]
fn page_table_image_installs_into_checked_guest_memory() {
    let mut tables = PageTablePlan::new();
    let user_stack = GuestAddress::new(0xd000).expect("canonical user-stack address");
    tables
        .map_user(user_stack, user_stack, PagePermissions::READ_WRITE)
        .expect("the user-stack mapping is valid");
    let image = tables
        .materialize_4k(GuestAddress::new(0x1000).expect("canonical table base"))
        .expect("the page-table image is materializable");
    let mut memory = GuestMemory::new(0x20_000);

    image
        .install(&mut memory)
        .expect("all table pages fit in guest memory");

    let supervisor_root = image.root(PageRoot::Supervisor);
    assert!(
        memory
            .read(supervisor_root, 4096)
            .expect("the installed root is readable")
            .iter()
            .any(|byte| *byte != 0)
    );
}

#[test]
fn page_mappings_reject_unaligned_addresses() {
    let mut tables = PageTablePlan::new();
    let aligned = GuestAddress::new(0x4000).expect("canonical aligned address");
    let unaligned = GuestAddress::new(0x4001).expect("canonical unaligned address");

    assert_eq!(
        tables.map_supervisor(unaligned, aligned, PagePermissions::READ_EXECUTE),
        Err(PagingError::Unaligned)
    );
    assert_eq!(
        tables.map_user(aligned, unaligned, PagePermissions::READ_WRITE),
        Err(PagingError::Unaligned)
    );
}

#[test]
fn overlapping_mappings_are_rejected_without_replacing_the_original() {
    let mut tables = PageTablePlan::new();
    let virtual_address = GuestAddress::new(0x8000).expect("canonical virtual address");
    let original = GuestAddress::new(0x10_0000).expect("canonical physical address");
    let replacement = GuestAddress::new(0x20_0000).expect("canonical physical address");

    tables
        .map_supervisor(virtual_address, original, PagePermissions::READ_WRITE)
        .expect("the first mapping is valid");
    assert_eq!(
        tables.map_user(virtual_address, replacement, PagePermissions::READ_EXECUTE,),
        Err(PagingError::Overlap)
    );
    assert_eq!(
        tables
            .translate(PageRoot::Supervisor, virtual_address)
            .expect("the original mapping remains")
            .physical,
        original
    );
    assert!(tables.translate(PageRoot::User, virtual_address).is_none());
}

#[test]
fn writable_executable_pages_are_rejected() {
    let mut tables = PageTablePlan::new();
    let page = GuestAddress::new(0x30_0000).expect("canonical page address");

    assert_eq!(
        tables.map_user(page, page, PagePermissions::READ_WRITE_EXECUTE),
        Err(PagingError::WritableExecutable)
    );
    assert!(tables.translate(PageRoot::Supervisor, page).is_none());
    assert!(tables.translate(PageRoot::User, page).is_none());
}

#[test]
fn materialized_page_tables_encode_distinct_isolated_roots() {
    let mut tables = PageTablePlan::new();
    let trampoline = GuestAddress::new(0xa000).expect("canonical trampoline address");
    let user_code = GuestAddress::new(0xc000).expect("canonical user-code address");

    tables
        .map_supervisor(trampoline, trampoline, PagePermissions::READ_EXECUTE)
        .expect("the supervisor mapping is valid");
    tables
        .map_user(user_code, user_code, PagePermissions::READ_EXECUTE)
        .expect("the user mapping is valid");

    let image = tables
        .materialize_4k(GuestAddress::new(0x1000).expect("canonical table base"))
        .expect("the one-PT image is materializable");

    assert_ne!(image.root(PageRoot::Supervisor), image.root(PageRoot::User));
    assert!(image.leaf_entry(PageRoot::User, trampoline).is_none());

    let supervisor_leaf = image
        .leaf_entry(PageRoot::Supervisor, trampoline)
        .expect("the supervisor root contains its trampoline");
    assert_eq!(supervisor_leaf & X86_PTE_USER, 0);

    for root in [PageRoot::Supervisor, PageRoot::User] {
        let user_leaf = image
            .leaf_entry(root, user_code)
            .expect("both roots contain user code");
        assert_eq!(
            user_leaf & (X86_PTE_PRESENT | X86_PTE_USER),
            X86_PTE_PRESENT | X86_PTE_USER
        );
        assert_eq!(user_leaf & X86_PTE_WRITABLE, 0);
    }
}

#[test]
fn cow_seal_write_protects_both_roots_and_tracks_leaf_entries() {
    let mut tables = PageTablePlan::new();
    let writable = GuestAddress::new(0x40_0000).expect("canonical writable page");
    let read_only = GuestAddress::new(0x41_0000).expect("canonical read-only page");
    tables
        .map_user(writable, writable, PagePermissions::READ_WRITE)
        .expect("the writable mapping is valid");
    tables
        .map_user(read_only, read_only, PagePermissions::READ_ONLY)
        .expect("the read-only mapping is valid");
    let mut image = tables
        .materialize_4k(GuestAddress::new(0x1000).expect("canonical table base"))
        .expect("the page tables are materializable");

    for root in [PageRoot::Supervisor, PageRoot::User] {
        assert_ne!(
            image
                .leaf_entry(root, writable)
                .expect("the writable leaf exists")
                & X86_PTE_WRITABLE,
            0
        );
    }

    let cow = image
        .seal_writable_user_pages()
        .expect("the materialized image matches its source plan");

    assert_eq!(cow.len(), 1);
    let page = cow
        .page(writable)
        .expect("the writable page is part of the COW contract");
    assert_eq!(page.virtual_address(), writable);
    assert_eq!(page.physical_address(), writable);
    assert_ne!(
        page.supervisor_leaf_entry_address(),
        page.user_leaf_entry_address(),
        "the isolated roots must not share a mutable leaf entry"
    );
    for root in [PageRoot::Supervisor, PageRoot::User] {
        assert_eq!(
            image
                .leaf_entry(root, writable)
                .expect("the sealed writable leaf remains present")
                & X86_PTE_WRITABLE,
            0
        );
        assert_eq!(
            image
                .leaf_entry(root, read_only)
                .expect("the read-only leaf remains present")
                & X86_PTE_WRITABLE,
            0
        );
    }
}

#[test]
fn warmup_cow_plan_tracks_leaves_without_write_protecting_them() {
    let mut plan = PageTablePlan::new();
    let writable = GuestAddress::new(0x42_0000).expect("canonical writable page");
    plan.map_user(writable, writable, PagePermissions::READ_WRITE)
        .expect("the writable mapping is valid");
    let image = plan
        .materialize_4k(GuestAddress::new(0x1000).expect("canonical table base"))
        .expect("the page tables are materializable");

    let cow = image
        .writable_user_page_plan()
        .expect("the warm-up image matches its mapping plan");

    assert_eq!(cow.len(), 1);
    assert_eq!(
        cow.pages().collect::<Vec<_>>(),
        [cow.page(writable).unwrap()]
    );
    for root in [PageRoot::Supervisor, PageRoot::User] {
        assert_ne!(
            image
                .leaf_entry(root, writable)
                .expect("the warm-up leaf remains present")
                & X86_PTE_WRITABLE,
            0,
            "warm-up must remain writable until the live checkpoint"
        );
    }
}
