/* SPDX-License-Identifier: GPL-2.0-only */
#ifndef _PVM_SOCKET_ABI_H
#define _PVM_SOCKET_ABI_H

#include <linux/types.h>

#define PVM_SOCK_G2H_GPA 0x100000000ULL
#define PVM_SOCK_H2G_GPA 0x100040000ULL
#define PVM_SOCK_REGION_SIZE (256U * 1024U)
#define PVM_SOCK_IRQ 10
#define PVM_SOCK_ABI_VERSION 6
#define PVM_SOCK_RING_ENTRIES 64U
#define PVM_SOCK_SLOT_COUNT 32U
#define PVM_SOCK_SLOT_SIZE 4096U
#define PVM_SOCK_CONNECTION_SLOTS 4U
#define PVM_SOCK_DESC_OFFSET 4096U
#define PVM_SOCK_DATA_OFFSET 8192U
#define PVM_SOCK_DRAIN_BUDGET 64U

#define PVM_G2H_REQUEST_PRODUCER 0U
#define PVM_G2H_RESPONSE_CONSUMER 4U
#define PVM_G2H_RESPONSE_EVENT 8U
#define PVM_G2H_REQUEST_CREDIT_EVENT 12U
#define PVM_H2G_MAGIC 0U
#define PVM_H2G_VERSION 8U
#define PVM_H2G_SESSION 16U
#define PVM_H2G_REQUEST_CONSUMER 24U
#define PVM_H2G_RESPONSE_PRODUCER 28U
#define PVM_H2G_FEATURES 32U
#define PVM_H2G_REQUEST_EVENT 40U
#define PVM_H2G_RESPONSE_CREDIT_EVENT 44U

#define PVM_CMD_TX 1U
#define PVM_CMD_RX_RELEASE 2U
#define PVM_CMD_CLOSE 3U
#define PVM_CMD_CONNECT 4U
#define PVM_CMD_SHUTDOWN 5U
#define PVM_CMD_DNS_QUERY 6U
#define PVM_CMD_INGRESS_ACK 7U
#define PVM_CMD_INGRESS_REJECT 8U
#define PVM_CMD_INGRESS_ACCEPT 9U

#define PVM_EVENT_CONNECTED 1U
#define PVM_EVENT_TX_COMPLETE 2U
#define PVM_EVENT_RX_READY 3U
#define PVM_EVENT_SHUTDOWN 4U
#define PVM_EVENT_CLOSED 5U
#define PVM_EVENT_ERROR 6U
#define PVM_EVENT_DNS_TX_COMPLETE 7U
#define PVM_EVENT_DNS_RX_READY 8U
#define PVM_EVENT_INGRESS_OFFER 9U
#define PVM_EVENT_INGRESS_CANCEL 10U
#define PVM_EVENT_INGRESS_ACCEPTED 11U

#define PVM_SOCK_FEATURE_TCP (1ULL << 0)
#define PVM_SOCK_FEATURE_DNS_UDP (1ULL << 1)
#define PVM_SOCK_FEATURE_INGRESS (1ULL << 2)
#define PVM_SOCK_INGRESS_SLOTS 32U
#define PVM_SOCK_LISTENERS 128U
#define PVM_SOCK_LISTENER_INGRESS 16U
#define PVM_DNS_PORT 53U
#define PVM_DNS_QUERY_MAX 512U
#define PVM_DNS_RESPONSE_MAX (PVM_SOCK_SLOT_SIZE - 8U)

#define PVM_HC_PORT 0x81
#define PVM_HC_SERVICE_NOTIFY 0x4d530106U
#define PVM_SERVICE_QUEUE_COMMAND 1UL

struct pvm_sock_desc {
	__le16 version;
	__le16 opcode;
	__le32 capability;
	__le64 generation;
	__le16 slot;
	__le16 flags;
	__le32 offset;
	__le32 length;
	__le32 sequence;
} __packed;

struct pvm_sock_event {
	__le16 version;
	__le16 kind;
	__le32 capability;
	__le64 generation;
	__le16 slot;
	__le16 flags;
	__le32 status;
	__le32 length;
	__le32 sequence;
} __packed;

struct pvm_sock_endpoint4 {
	__le16 family;
	__be16 port;
	__be32 address;
} __packed;

static __always_inline void pvm_sock_notify(void)
{
	u32 request = PVM_HC_SERVICE_NOTIFY;
	u16 port = PVM_HC_PORT;
	unsigned long queues = PVM_SERVICE_QUEUE_COMMAND;

	/* Descriptor and cursor stores must precede the completed PIO exit. */
	wmb();
	asm volatile("outl %0, %w1"
		     :
		     : "a"(request), "Nd"(port), "D"(queues)
		     : "memory");
}

/* Equivalent to virtio's EVENT_IDX test, widened to the u32 ring cursors. */
static __always_inline bool pvm_sock_need_event(u32 event, u32 new,
						u32 old)
{
	return (u32)(new - event - 1) < (u32)(new - old);
}

#endif
