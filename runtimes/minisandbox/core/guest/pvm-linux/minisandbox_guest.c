// SPDX-License-Identifier: GPL-2.0-only

#include <linux/fs.h>
#include <linux/gfp.h>
#include <linux/init.h>
#include <linux/io.h>
#include <linux/miscdevice.h>
#include <linux/module.h>
#include <linux/page_reporting.h>
#include <linux/preempt.h>
#include <linux/scatterlist.h>
#include <linux/slab.h>

#define MINISANDBOX_HC_PORT 0x81
#define MINISANDBOX_HC_MAGIC 0x4d530000U
#define MINISANDBOX_HC_VERSION 1U
#define MINISANDBOX_HC_EXIT 2U
#define MINISANDBOX_HC_CHECKPOINT_READY 3U
#define MINISANDBOX_HC_BENCHMARK_POINT 4U
#define MINISANDBOX_HC_PAGE_REPORT 5U
#define MINISANDBOX_HC_SERVICE_NOTIFY 6U
#define MINISANDBOX_SERVICE_QUEUE_COMMAND (1UL << 0)
#define MINISANDBOX_SERVICE_QUEUE_ALLOWED MINISANDBOX_SERVICE_QUEUE_COMMAND
#define MINISANDBOX_HC_ENCODE(operation)                                    \
	(MINISANDBOX_HC_MAGIC | (MINISANDBOX_HC_VERSION << 8) | (operation))

#define MINISANDBOX_PAGE_REPORT_MAGIC 0x4d535052U
#define MINISANDBOX_PAGE_REPORT_VERSION 1U
#define MINISANDBOX_PAGE_REPORT_RANGES 32U
#define MINISANDBOX_PAGE_REPORT_MAX_PAGES 512U

#define MINISANDBOX_IOCTL_MAGIC 0xb7
#define MINISANDBOX_IOCTL_CHECKPOINT _IO(MINISANDBOX_IOCTL_MAGIC, 1)
#define MINISANDBOX_IOCTL_BENCHMARK_POINT _IO(MINISANDBOX_IOCTL_MAGIC, 2)
#define MINISANDBOX_IOCTL_EXIT _IO(MINISANDBOX_IOCTL_MAGIC, 3)

struct minisandbox_page_range {
	__le64 start_gpa;
	__le32 page_count;
	__le32 flags;
};

struct minisandbox_page_report {
	__le32 magic;
	__le16 version;
	__le16 count;
	__le64 sequence;
	__le64 reserved[2];
	struct minisandbox_page_range ranges[MINISANDBOX_PAGE_REPORT_RANGES];
};

static unsigned long minisandbox_report_page;
static u64 minisandbox_report_sequence;
static atomic_t minisandbox_checkpoint_published = ATOMIC_INIT(0);
static atomic_t minisandbox_reporting_started = ATOMIC_INIT(0);
static atomic_t minisandbox_pcp_drained = ATOMIC_INIT(0);
static struct page_reporting_dev_info minisandbox_reporting;

/* Exported by mm/page_reporting.c for the single registered reporter. */
extern unsigned int page_reporting_order;

static noinline void minisandbox_hypercall(u32 operation,
					   unsigned long argument)
{
	u32 request = MINISANDBOX_HC_ENCODE(operation);
	u16 port = MINISANDBOX_HC_PORT;

	/*
	 * KVM completes OUT before returning to userspace. A cloned VCPU can
	 * therefore resume at the following instruction without hidden PIO input
	 * completion state. RDI is an explicit ABI argument sampled at that exit;
	 * runtime PAGE_REPORT calls pass zero because the descriptor GPA was fixed
	 * at the checkpoint boundary.
	 */
	preempt_disable();
	asm volatile("outl %0, %w1"
		     :
		     : "a"(request), "Nd"(port), "D"(argument)
		     : "memory");
	preempt_enable_no_resched();
}

/*
 * Future stream-provider calls publish fixed-ring descriptors, execute wmb(),
 * and pass only this queue-set mask. The host rejects zero and unknown bits;
 * no GPA, descriptor count, socket ID, or endpoint crosses in a hypercall.
 */
static __always_inline __maybe_unused void
minisandbox_service_notify(unsigned long queues)
{
	if (WARN_ON_ONCE(!queues ||
			 queues & ~MINISANDBOX_SERVICE_QUEUE_ALLOWED))
		return;
	wmb();
	minisandbox_hypercall(MINISANDBOX_HC_SERVICE_NOTIFY, queues);
}

static int minisandbox_flush_page_report(struct minisandbox_page_report *report,
					 unsigned int count)
{
	if (!count)
		return 0;
	report->magic = cpu_to_le32(MINISANDBOX_PAGE_REPORT_MAGIC);
	report->version = cpu_to_le16(MINISANDBOX_PAGE_REPORT_VERSION);
	report->count = cpu_to_le16(count);
	report->sequence = cpu_to_le64(++minisandbox_report_sequence);
	/* Publish every descriptor byte before the completed OUT instruction. */
	wmb();
	minisandbox_hypercall(MINISANDBOX_HC_PAGE_REPORT, 0);
	memset(report, 0, PAGE_SIZE);
	return 0;
}

static int minisandbox_report_free_pages(struct page_reporting_dev_info *prdev,
					 struct scatterlist *sg,
					 unsigned int nents)
{
	struct minisandbox_page_report *report =
		(void *)minisandbox_report_page;
	struct scatterlist *entry;
	unsigned int count = 0;
	unsigned int index;

	(void)prdev;
	/*
	 * The initial reporting cycle is guaranteed after clone resume. Flush this
	 * single-vCPU guest's per-CPU page cache once so pages released immediately
	 * after checkpoint are visible in the following buddy scan.
	 */
	if (!atomic_cmpxchg(&minisandbox_pcp_drained, 0, 1))
		drain_all_pages(NULL);
	memset(report, 0, PAGE_SIZE);
	for_each_sg(sg, entry, nents, index) {
		phys_addr_t start = page_to_phys(sg_page(entry)) + entry->offset;
		unsigned int pages;

		if (!IS_ALIGNED(start, PAGE_SIZE) ||
		    !IS_ALIGNED(entry->length, PAGE_SIZE))
			return -EINVAL;
		pages = entry->length >> PAGE_SHIFT;
		while (pages) {
			unsigned int chunk =
				min(pages, MINISANDBOX_PAGE_REPORT_MAX_PAGES);

			if (count == MINISANDBOX_PAGE_REPORT_RANGES) {
				minisandbox_flush_page_report(report, count);
				count = 0;
			}
			report->ranges[count].start_gpa = cpu_to_le64(start);
			report->ranges[count].page_count = cpu_to_le32(chunk);
			count++;
			start += (phys_addr_t)chunk << PAGE_SHIFT;
			pages -= chunk;
		}
	}
	return minisandbox_flush_page_report(report, count);
}

static int minisandbox_start_page_reporting(void)
{
	int error;

	if (atomic_cmpxchg(&minisandbox_reporting_started, 0, 1))
		return 0;
	/* Order zero is required to reclaim isolated 4 KiB free pages. */
	if (page_reporting_order == (unsigned int)-1)
		page_reporting_order = 0;
	minisandbox_reporting.report = minisandbox_report_free_pages;
	error = page_reporting_register(&minisandbox_reporting);
	if (error)
		atomic_set(&minisandbox_reporting_started, 0);
	return error;
}

static long minisandbox_ioctl(struct file *file, unsigned int command,
			      unsigned long argument)
{
	(void)file;
	(void)argument;
	if (command == MINISANDBOX_IOCTL_CHECKPOINT) {
		/*
		 * This latch is captured before the completed OUT.  The original
		 * template never resumes, while each clone continues below the OUT
		 * exactly once.  A later ioctl in a clone therefore fails locally and
		 * cannot manufacture another checkpoint exit.
		 */
		if (atomic_cmpxchg(&minisandbox_checkpoint_published, 0, 1))
			return -EALREADY;
		minisandbox_hypercall(
			MINISANDBOX_HC_CHECKPOINT_READY,
			virt_to_phys((void *)minisandbox_report_page));
		return minisandbox_start_page_reporting();
	} else if (command == MINISANDBOX_IOCTL_BENCHMARK_POINT) {
		minisandbox_hypercall(MINISANDBOX_HC_BENCHMARK_POINT, 0);
	} else if (command == MINISANDBOX_IOCTL_EXIT) {
		if (argument > 255)
			return -EINVAL;
		minisandbox_hypercall(MINISANDBOX_HC_EXIT, argument);
		/* A conforming host consumes EXIT and never resumes this ioctl. */
		return -EIO;
	} else {
		return -ENOTTY;
	}
	return 0;
}

static const struct file_operations minisandbox_fops = {
	.owner = THIS_MODULE,
	.unlocked_ioctl = minisandbox_ioctl,
#ifdef CONFIG_COMPAT
	.compat_ioctl = minisandbox_ioctl,
#endif
};

static struct miscdevice minisandbox_device = {
	.minor = MISC_DYNAMIC_MINOR,
	.name = "minisandbox",
	.fops = &minisandbox_fops,
	.mode = 0600,
};

static int __init minisandbox_guest_init(void)
{
	int error;

	static_assert(sizeof(struct minisandbox_page_report) <= PAGE_SIZE);
	minisandbox_report_page = get_zeroed_page(GFP_KERNEL);
	if (!minisandbox_report_page)
		return -ENOMEM;
	error = misc_register(&minisandbox_device);
	if (error)
		free_page(minisandbox_report_page);
	return error;
}
device_initcall(minisandbox_guest_init);

MODULE_DESCRIPTION("minisandbox PVM guest checkpoint control");
MODULE_LICENSE("GPL");
