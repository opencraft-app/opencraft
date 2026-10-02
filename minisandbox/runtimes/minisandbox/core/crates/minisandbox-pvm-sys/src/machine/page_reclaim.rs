//! Auditable host boundary for returning clone-private RAM to its template.

use std::{io, ops::Range};

use super::{HostMapping, PvmMachine, kvm_error, memory_error};
use crate::PvmDeviceError;

const PAGE_SIZE: usize = 4096;
const DESCRIPTOR_MAGIC: u32 = 0x4d53_5052;
const DESCRIPTOR_VERSION: u16 = 1;
const DESCRIPTOR_HEADER_SIZE: usize = 32;
const RANGE_DESCRIPTOR_SIZE: usize = 16;
const MAX_RANGES: usize = 32;
const MAX_PAGES_PER_RANGE: usize = 512;
const MAX_PAGES_PER_REPORT: usize = MAX_RANGES * MAX_PAGES_PER_RANGE;
const MAX_DISCARD_RUNS: usize = 256;

#[derive(Debug)]
pub(super) struct PageReclaimState {
    descriptor_gpa: Option<u64>,
    last_sequence: u64,
    private_bitmap: Vec<u64>,
}

impl PageReclaimState {
    pub(super) fn new(memory_length: usize) -> Self {
        let page_count = memory_length.div_ceil(PAGE_SIZE);
        Self {
            descriptor_gpa: None,
            last_sequence: 0,
            private_bitmap: vec![0; page_count.div_ceil(u64::BITS as usize)],
        }
    }

    fn is_private(&self, page: usize) -> bool {
        self.private_bitmap
            .get(page / u64::BITS as usize)
            .is_some_and(|word| word & (1_u64 << (page % u64::BITS as usize)) != 0)
    }

    fn clear_private_range(&mut self, pages: Range<usize>) -> usize {
        let mut cleared = 0;
        for page in pages {
            let word = &mut self.private_bitmap[page / u64::BITS as usize];
            let mask = 1_u64 << (page % u64::BITS as usize);
            cleared += usize::from(*word & mask != 0);
            *word &= !mask;
        }
        cleared
    }

    fn private_page_count(&self) -> usize {
        self.private_bitmap
            .iter()
            .map(|word| word.count_ones() as usize)
            .sum()
    }
}

impl PvmMachine {
    /// Validates the fixed page-report descriptor GPA published at checkpoint.
    ///
    /// The guest supplies this address once while its vCPU is stopped at the
    /// completed checkpoint `OUT`. Runtime page-report hypercalls carry no
    /// address, so every later descriptor read uses this immutable GPA.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError`] when the register cannot be read or does not
    /// name one complete, aligned page inside writable RAM slot zero.
    pub fn checkpoint_page_report_descriptor_gpa(&self) -> Result<u64, PvmDeviceError> {
        let descriptor_gpa = self
            .vcpu
            .get_regs()
            .map_err(|error| kvm_error("read page-report descriptor register", error))?
            .rdi;
        validate_descriptor_gpa(self.memory.length, descriptor_gpa)?;
        Ok(descriptor_gpa)
    }

    /// Enables page reclaim for a dirty-tracked template clone.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError`] when dirty tracking is unavailable, the
    /// machine is not template-backed, or the descriptor page is invalid.
    pub fn configure_page_reclaim(&mut self, descriptor_gpa: u64) -> Result<(), PvmDeviceError> {
        validate_descriptor_gpa(self.memory.length, descriptor_gpa)?;
        if self.memory.backing_id.is_none() {
            return Err(reclaim_error(
                "page reclaim requires a sealed template mapping",
            ));
        }
        let state = self.page_reclaim.as_mut().ok_or_else(|| {
            reclaim_error("page reclaim requires KVM dirty-page logging on RAM slot zero")
        })?;
        if state.descriptor_gpa.is_some() {
            return Err(reclaim_error(
                "page-report descriptor GPA was already configured",
            ));
        }
        state.descriptor_gpa = Some(descriptor_gpa);
        Ok(())
    }

    /// Handles one bounded page-report hypercall while the vCPU is stopped.
    ///
    /// Guest bytes are copied before parsing. Only reported pages already
    /// present in the host-owned private bitmap are discarded, and successful
    /// `MADV_DONTNEED` calls are reflected in that bitmap before returning.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError`] for malformed descriptors, invalid ranges,
    /// KVM dirty-log failures, or an unsuccessful host reclaim operation.
    pub fn handle_page_report(&mut self) -> Result<usize, PvmDeviceError> {
        let state = self
            .page_reclaim
            .as_ref()
            .ok_or_else(|| reclaim_error("page report received without dirty-page tracking"))?;
        let descriptor_gpa = state
            .descriptor_gpa
            .ok_or_else(|| reclaim_error("page report received before descriptor registration"))?;

        // Copy the complete fixed page before interpreting attacker-controlled
        // offsets. The stopped vCPU cannot race this snapshot of its bytes.
        let descriptor = self.memory.read(descriptor_gpa, PAGE_SIZE)?;
        let report = parse_descriptor(&descriptor, self.memory.length, descriptor_gpa)?;
        if report.sequence <= state.last_sequence {
            return Err(reclaim_error("page-report sequence is stale or replayed"));
        }

        self.refresh_private_bitmap()?;
        let state = self
            .page_reclaim
            .as_ref()
            .ok_or_else(|| reclaim_error("page-reclaim state disappeared during report"))?;
        let discard_runs = private_runs(state, &report.ranges)?;

        let mut reclaimed_pages = 0;
        for pages in discard_runs {
            self.memory.discard_template_pages(pages.clone())?;
            reclaimed_pages += self
                .page_reclaim
                .as_mut()
                .ok_or_else(|| reclaim_error("page-reclaim state disappeared during discard"))?
                .clear_private_range(pages);
        }
        self.page_reclaim
            .as_mut()
            .ok_or_else(|| reclaim_error("page-reclaim state disappeared after discard"))?
            .last_sequence = report.sequence;
        Ok(reclaimed_pages)
    }

    /// Counts clone-private pages that have not been returned to the template.
    ///
    /// Reading KVM's incremental dirty bitmap first establishes a current
    /// measurement boundary. Unlike a raw dirty-log count, this value can fall
    /// after a successful page report.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError`] if dirty tracking was not enabled or KVM
    /// cannot return slot zero's bitmap.
    pub fn private_page_count(&mut self) -> Result<usize, PvmDeviceError> {
        self.refresh_private_bitmap()?;
        Ok(self
            .page_reclaim
            .as_ref()
            .ok_or_else(|| reclaim_error("dirty tracking has no private-page bitmap"))?
            .private_page_count())
    }

    fn refresh_private_bitmap(&mut self) -> Result<(), PvmDeviceError> {
        if !self.tracks_dirty_pages {
            return Err(PvmDeviceError::Kvm {
                operation: "read clone dirty pages",
                message: "machine was not created with dirty logging".to_owned(),
            });
        }
        let dirty = self
            .vm
            .get_dirty_log(0, self.memory.length)
            .map_err(|error| kvm_error("read clone dirty pages", error))?;
        let state = self
            .page_reclaim
            .as_mut()
            .ok_or_else(|| reclaim_error("dirty tracking has no private-page bitmap"))?;
        if dirty.len() != state.private_bitmap.len() {
            return Err(PvmDeviceError::Kvm {
                operation: "read clone dirty pages",
                message: format!(
                    "dirty bitmap has {} words, expected {}",
                    dirty.len(),
                    state.private_bitmap.len()
                ),
            });
        }
        for (private, observed) in state.private_bitmap.iter_mut().zip(dirty) {
            *private |= observed;
        }
        Ok(())
    }
}

impl HostMapping {
    fn discard_template_pages(&mut self, pages: Range<usize>) -> Result<(), PvmDeviceError> {
        if self.backing_id.is_none() {
            return Err(reclaim_error(
                "cannot discard pages from anonymous guest RAM",
            ));
        }
        let byte_start = pages
            .start
            .checked_mul(PAGE_SIZE)
            .ok_or_else(|| reclaim_error("discard start overflowed"))?;
        let byte_end = pages
            .end
            .checked_mul(PAGE_SIZE)
            .ok_or_else(|| reclaim_error("discard end overflowed"))?;
        if byte_start >= byte_end || byte_end > self.length {
            return Err(reclaim_error("discard range is empty or outside guest RAM"));
        }
        // SAFETY: The page range was derived from checked slot-zero offsets,
        // lies inside this live MAP_PRIVATE mapping, and `&mut self` excludes a
        // concurrent KVM run while MADV_DONTNEED invalidates the host mapping.
        let result = unsafe {
            libc::madvise(
                self.pointer.as_ptr().add(byte_start).cast(),
                byte_end - byte_start,
                libc::MADV_DONTNEED,
            )
        };
        if result != 0 {
            return Err(memory_error(
                "return private pages to template",
                io::Error::last_os_error(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Eq, PartialEq)]
struct PageReport {
    sequence: u64,
    ranges: Vec<Range<usize>>,
}

fn parse_descriptor(
    descriptor: &[u8],
    memory_length: usize,
    descriptor_gpa: u64,
) -> Result<PageReport, PvmDeviceError> {
    if descriptor.len() != PAGE_SIZE {
        return Err(reclaim_error("page-report descriptor is not one page"));
    }
    if read_u32(descriptor, 0) != DESCRIPTOR_MAGIC {
        return Err(reclaim_error("page-report descriptor magic is invalid"));
    }
    if read_u16(descriptor, 4) != DESCRIPTOR_VERSION {
        return Err(reclaim_error(
            "page-report descriptor version is unsupported",
        ));
    }
    let count = usize::from(read_u16(descriptor, 6));
    if count == 0 || count > MAX_RANGES {
        return Err(reclaim_error(
            "page-report range count is outside its bound",
        ));
    }
    if descriptor[16..DESCRIPTOR_HEADER_SIZE]
        .iter()
        .any(|byte| *byte != 0)
    {
        return Err(reclaim_error(
            "page-report reserved header bytes are nonzero",
        ));
    }

    let memory_pages = memory_length / PAGE_SIZE;
    let descriptor_page = usize::try_from(descriptor_gpa)
        .map_err(|error| memory_error("convert page-report descriptor GPA", error))?
        / PAGE_SIZE;
    let mut total_pages = 0_usize;
    let mut ranges = Vec::with_capacity(count);
    for index in 0..count {
        let offset = DESCRIPTOR_HEADER_SIZE + index * RANGE_DESCRIPTOR_SIZE;
        let start_gpa = read_u64(descriptor, offset);
        let page_count = usize::try_from(read_u32(descriptor, offset + 8))
            .map_err(|error| memory_error("convert reported page count", error))?;
        let flags = read_u32(descriptor, offset + 12);
        if flags != 0 {
            return Err(reclaim_error("page-report range flags are unsupported"));
        }
        if !start_gpa.is_multiple_of(PAGE_SIZE as u64) {
            return Err(reclaim_error("reported GPA is not page aligned"));
        }
        if page_count == 0 || page_count > MAX_PAGES_PER_RANGE {
            return Err(reclaim_error(
                "reported range page count is outside its bound",
            ));
        }
        total_pages = total_pages
            .checked_add(page_count)
            .filter(|total| *total <= MAX_PAGES_PER_REPORT)
            .ok_or_else(|| reclaim_error("page-report total exceeds its bound"))?;
        let start_page = usize::try_from(start_gpa / PAGE_SIZE as u64)
            .map_err(|error| memory_error("convert reported GPA", error))?;
        let end_page = start_page
            .checked_add(page_count)
            .filter(|end| *end <= memory_pages)
            .ok_or_else(|| reclaim_error("reported range is outside writable RAM"))?;
        if start_page <= descriptor_page && descriptor_page < end_page {
            return Err(reclaim_error("page report includes its descriptor page"));
        }
        ranges.push(start_page..end_page);
    }

    ranges.sort_unstable_by_key(|range| range.start);
    let mut normalized: Vec<Range<usize>> = Vec::with_capacity(ranges.len());
    for range in ranges {
        if let Some(previous) = normalized.last_mut() {
            if range.start < previous.end {
                return Err(reclaim_error("reported ranges overlap"));
            }
            if range.start == previous.end {
                previous.end = range.end;
                continue;
            }
        }
        normalized.push(range);
    }

    Ok(PageReport {
        sequence: read_u64(descriptor, 8),
        ranges: normalized,
    })
}

fn private_runs(
    state: &PageReclaimState,
    reported: &[Range<usize>],
) -> Result<Vec<Range<usize>>, PvmDeviceError> {
    let mut runs = Vec::new();
    for reported_range in reported {
        let mut page = reported_range.start;
        while page < reported_range.end {
            if !state.is_private(page) {
                page += 1;
                continue;
            }
            let start = page;
            page += 1;
            while page < reported_range.end && state.is_private(page) {
                page += 1;
            }
            if runs.len() == MAX_DISCARD_RUNS {
                return Err(reclaim_error("page report creates too many discard runs"));
            }
            runs.push(start..page);
        }
    }
    Ok(runs)
}

fn validate_descriptor_gpa(
    memory_length: usize,
    descriptor_gpa: u64,
) -> Result<(), PvmDeviceError> {
    if !descriptor_gpa.is_multiple_of(PAGE_SIZE as u64) {
        return Err(reclaim_error("page-report descriptor GPA is not aligned"));
    }
    let start = usize::try_from(descriptor_gpa)
        .map_err(|error| memory_error("convert page-report descriptor GPA", error))?;
    let end = start
        .checked_add(PAGE_SIZE)
        .filter(|end| *end <= memory_length)
        .ok_or_else(|| reclaim_error("page-report descriptor is outside writable RAM"))?;
    debug_assert!(start < end);
    Ok(())
}

fn read_u16(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(
        bytes[offset..offset + size_of::<u16>()]
            .try_into()
            .expect("fixed descriptor field is in bounds"),
    )
}

fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(
        bytes[offset..offset + size_of::<u32>()]
            .try_into()
            .expect("fixed descriptor field is in bounds"),
    )
}

fn read_u64(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(
        bytes[offset..offset + size_of::<u64>()]
            .try_into()
            .expect("fixed descriptor field is in bounds"),
    )
}

fn reclaim_error(message: impl Into<String>) -> PvmDeviceError {
    PvmDeviceError::Memory {
        operation: "reclaim clone-private pages",
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::PvmMemoryTemplate;

    fn descriptor(sequence: u64, ranges: &[(u64, u32, u32)]) -> Vec<u8> {
        let mut bytes = vec![0; PAGE_SIZE];
        bytes[0..4].copy_from_slice(&DESCRIPTOR_MAGIC.to_le_bytes());
        bytes[4..6].copy_from_slice(&DESCRIPTOR_VERSION.to_le_bytes());
        bytes[6..8].copy_from_slice(
            &u16::try_from(ranges.len())
                .expect("test range count fits u16")
                .to_le_bytes(),
        );
        bytes[8..16].copy_from_slice(&sequence.to_le_bytes());
        for (index, (start, count, flags)) in ranges.iter().enumerate() {
            let offset = DESCRIPTOR_HEADER_SIZE + index * RANGE_DESCRIPTOR_SIZE;
            bytes[offset..offset + 8].copy_from_slice(&start.to_le_bytes());
            bytes[offset + 8..offset + 12].copy_from_slice(&count.to_le_bytes());
            bytes[offset + 12..offset + 16].copy_from_slice(&flags.to_le_bytes());
        }
        bytes
    }

    #[test]
    fn madvise_reveals_the_immutable_template_again() {
        let mut baseline = vec![0x11; PAGE_SIZE];
        baseline.extend(vec![0x22; PAGE_SIZE]);
        let template = PvmMemoryTemplate::from_bytes(&baseline).expect("sealed template");
        let mut mapping = HostMapping::from_template(&template).expect("private mapping");
        let sibling = HostMapping::from_template(&template).expect("sibling mapping");

        mapping
            .write(PAGE_SIZE as u64, &[0x99; PAGE_SIZE])
            .expect("materialize private page");
        assert_eq!(
            mapping.read(PAGE_SIZE as u64, PAGE_SIZE).expect("read COW"),
            vec![0x99; PAGE_SIZE]
        );
        assert_eq!(
            sibling.read(0, PAGE_SIZE * 2).expect("read sibling"),
            baseline
        );

        mapping
            .discard_template_pages(1..2)
            .expect("discard private page");
        assert_eq!(
            mapping.read(0, PAGE_SIZE * 2).expect("read template"),
            baseline
        );

        mapping
            .write(PAGE_SIZE as u64, &[0x77; PAGE_SIZE])
            .expect("materialize COW page again");
        assert_eq!(
            mapping
                .read(PAGE_SIZE as u64, PAGE_SIZE)
                .expect("read second COW"),
            vec![0x77; PAGE_SIZE]
        );
        assert_eq!(
            template.read_memory(0, PAGE_SIZE * 2).expect("read base"),
            baseline
        );
    }

    #[test]
    fn descriptor_parser_normalizes_adjacent_bounded_ranges() {
        let bytes = descriptor(7, &[(0x3000, 2, 0), (0x1000, 2, 0)]);
        let report = parse_descriptor(&bytes, PAGE_SIZE * 16, 0).expect("valid report");
        assert_eq!(
            report,
            PageReport {
                sequence: 7,
                ranges: std::iter::once(1..5).collect()
            }
        );
    }

    #[test]
    fn descriptor_parser_rejects_untrusted_range_shapes() {
        let mut bad_magic = descriptor(1, &[(0x1000, 1, 0)]);
        bad_magic[0] = 0;
        let mut bad_version = descriptor(1, &[(0x1000, 1, 0)]);
        bad_version[4..6].copy_from_slice(&2_u16.to_le_bytes());
        let mut bad_reserved = descriptor(1, &[(0x1000, 1, 0)]);
        bad_reserved[16] = 1;
        let cases = [
            bad_magic,
            bad_version,
            bad_reserved,
            descriptor(1, &[]),
            descriptor(1, &[(1, 1, 0)]),
            descriptor(1, &[(0x1000, 0, 0)]),
            descriptor(1, &[(0x1000, 1, 1)]),
            descriptor(1, &[(0x3000, 2, 0), (0x4000, 1, 0)]),
            descriptor(1, &[(0xf000, 2, 0)]),
            descriptor(1, &[(0x8000, 2, 0)]),
        ];
        for bytes in cases {
            assert!(
                parse_descriptor(&bytes, PAGE_SIZE * 16, 0x8000).is_err(),
                "accepted malformed descriptor"
            );
        }
    }

    #[test]
    fn only_reported_private_pages_form_discard_runs() {
        let mut state = PageReclaimState::new(PAGE_SIZE * 64);
        state.private_bitmap[0] = (1 << 1) | (1 << 2) | (1 << 4) | (1 << 9);
        assert_eq!(
            private_runs(&state, &[0..6, 8..10]).expect("bounded runs"),
            vec![1..3, 4..5, 9..10]
        );
    }
}
