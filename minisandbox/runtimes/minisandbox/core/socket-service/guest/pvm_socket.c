// SPDX-License-Identifier: GPL-2.0-only

#include <linux/atomic.h>
#include <linux/bitmap.h>
#include <linux/errno.h>
#include <linux/file.h>
#include <linux/in.h>
#include <linux/init.h>
#include <linux/interrupt.h>
#include <linux/io.h>
#include <linux/list.h>
#include <linux/module.h>
#include <linux/net.h>
#include <linux/poll.h>
#include <linux/sched/signal.h>
#include <linux/socket.h>
#include <linux/spinlock.h>
#include <linux/tcp.h>
#include <linux/uio.h>
#include <linux/wait.h>
#include <net/net_namespace.h>
#include <net/sock.h>

#include "pvm_socket_abi.h"
#include "pvm_socket_local.h"

#define PVM_SOCK_CAPABILITIES 128U

enum pvm_transport {
	PVM_TRANSPORT_NONE,
	PVM_TRANSPORT_LOCAL,
	PVM_TRANSPORT_BROKER,
};

struct pvm_ingress_offer {
	u16 index;
	u64 generation;
	struct sockaddr_in local;
	struct sockaddr_in peer;
};

struct pvm_sock {
	struct sock sk;
	struct pvm_local_socket local;
	enum pvm_transport transport;
	u32 capability;
	u64 generation;
	u32 sequence;
	u32 tx_inflight;
	u16 rx_queue[PVM_SOCK_CONNECTION_SLOTS];
	u8 rx_head;
	u8 rx_count;
	struct sockaddr_in peer;
	struct sockaddr_in bound;
	struct list_head listener_node;
	struct pvm_ingress_offer ingress[PVM_SOCK_LISTENER_INGRESS];
	u8 ingress_head;
	u8 ingress_count;
	u8 ingress_limit;
	int error;
	bool connected;
	bool peer_closed;
	bool datagram;
	bool broker_opened;
	bool capability_allocated;
	bool tcp_nodelay;
	bool listening;
	bool accept_broker_turn;
};

struct pvm_tx_waiter {
	struct list_head node;
	struct pvm_sock *ps;
	int slot;
	bool granted;
};

static void *pvm_g2h;
static void *pvm_h2g;
static DEFINE_SPINLOCK(pvm_ring_lock);
static DECLARE_WAIT_QUEUE_HEAD(pvm_tx_wait);
static DECLARE_WAIT_QUEUE_HEAD(pvm_ring_wait);
static LIST_HEAD(pvm_tx_waiters);
static LIST_HEAD(pvm_listeners);
static unsigned int pvm_listener_count;
static DECLARE_BITMAP(pvm_capability_busy, PVM_SOCK_CAPABILITIES);
static DECLARE_BITMAP(pvm_tx_busy, PVM_SOCK_SLOT_COUNT);
static u32 pvm_tx_capability[PVM_SOCK_SLOT_COUNT];
static u64 pvm_tx_generation[PVM_SOCK_SLOT_COUNT];
static atomic_t pvm_stream_senders = ATOMIC_INIT(0);
static u64 pvm_capability_generation[PVM_SOCK_CAPABILITIES];
static u64 pvm_capability_closing[PVM_SOCK_CAPABILITIES];
static struct pvm_sock *pvm_capability_socket[PVM_SOCK_CAPABILITIES];
static struct pvm_sock *pvm_rx_owner[PVM_SOCK_SLOT_COUNT];
static u32 pvm_rx_length[PVM_SOCK_SLOT_COUNT];
static u32 pvm_rx_offset[PVM_SOCK_SLOT_COUNT];
static u32 pvm_request_producer;
static u32 pvm_response_consumer;
static bool pvm_protocol_fault;
static int pvm_irq_cookie;

static struct proto pvm_stream_proto;
static struct proto pvm_datagram_proto;
static const struct proto_ops pvm_stream_ops;
static const struct proto_ops pvm_datagram_ops;
static int pvm_release(struct socket *sock);

static inline struct pvm_sock *pvm_sk(struct sock *sk)
{
	return container_of(sk, struct pvm_sock, sk);
}

static inline u32 *pvm_g2h_word(unsigned int offset)
{
	return (u32 *)((u8 *)pvm_g2h + offset);
}

static inline u32 *pvm_h2g_word(unsigned int offset)
{
	return (u32 *)((u8 *)pvm_h2g + offset);
}

static inline void *pvm_tx_slot(unsigned int slot)
{
	return (u8 *)pvm_g2h + PVM_SOCK_DATA_OFFSET +
	       slot * PVM_SOCK_SLOT_SIZE;
}

static inline const void *pvm_rx_slot(unsigned int slot)
{
	return (u8 *)pvm_h2g + PVM_SOCK_DATA_OFFSET +
	       slot * PVM_SOCK_SLOT_SIZE;
}

static bool pvm_request_has_space(void)
{
	u32 consumed = smp_load_acquire(
		pvm_h2g_word(PVM_H2G_REQUEST_CONSUMER));

	return pvm_request_producer - consumed < PVM_SOCK_RING_ENTRIES;
}

static void pvm_arm_request_credit(void)
{
	u32 consumed = smp_load_acquire(
		pvm_h2g_word(PVM_H2G_REQUEST_CONSUMER));

	/* Publish the requested crossing before checking for already-freed space.
	 * This must be mb(), not smp_mb(): the peer is a host thread and this
	 * guest deliberately builds CONFIG_SMP=n. */
	smp_store_release(pvm_g2h_word(PVM_G2H_REQUEST_CREDIT_EVENT), consumed);
	mb();
}

/* Caller owns pvm_ring_lock. */
static int pvm_publish_locked(struct pvm_sock *ps, u16 opcode, u16 slot,
				      u32 offset, u32 length, bool *notify)
{
	struct pvm_sock_desc *ring;
	u32 old_producer = pvm_request_producer;
	struct pvm_sock_desc descriptor = {
		.version = cpu_to_le16(PVM_SOCK_ABI_VERSION),
		.opcode = cpu_to_le16(opcode),
		.capability = cpu_to_le32(ps->capability),
		.generation = cpu_to_le64(ps->generation),
		.slot = cpu_to_le16(slot),
		.offset = cpu_to_le32(offset),
		.length = cpu_to_le32(length),
		.sequence = cpu_to_le32(++ps->sequence),
	};

	if (!pvm_request_has_space())
		return -EAGAIN;
	ring = (void *)((u8 *)pvm_g2h + PVM_SOCK_DESC_OFFSET);
	memcpy(&ring[pvm_request_producer % PVM_SOCK_RING_ENTRIES],
	       &descriptor, sizeof(descriptor));
	smp_store_release(pvm_g2h_word(PVM_G2H_REQUEST_PRODUCER),
				  ++pvm_request_producer);
	/* Pair with the host arm/recheck barrier. A release store followed by an
	 * acquire load still permits both peers to observe stale values. mb() is
	 * required because smp_mb() may compile away in this uniprocessor guest. */
	mb();
	*notify |= pvm_sock_need_event(
		smp_load_acquire(pvm_h2g_word(PVM_H2G_REQUEST_EVENT)),
		pvm_request_producer, old_producer);
	return 0;
}

/* Caller owns pvm_ring_lock. Pending ingress IDs are not stream capabilities. */
static int pvm_publish_ingress_reply_locked(u16 opcode, u16 index,
					     u64 generation, bool *notify)
{
	struct pvm_sock_desc *ring;
	u32 old_producer = pvm_request_producer;
	struct pvm_sock_desc descriptor = {
		.version = cpu_to_le16(PVM_SOCK_ABI_VERSION),
		.opcode = cpu_to_le16(opcode),
		.capability = cpu_to_le32(index),
		.generation = cpu_to_le64(generation),
	};

	if (!pvm_request_has_space())
		return -EAGAIN;
	ring = (void *)((u8 *)pvm_g2h + PVM_SOCK_DESC_OFFSET);
	memcpy(&ring[pvm_request_producer % PVM_SOCK_RING_ENTRIES],
	       &descriptor, sizeof(descriptor));
	smp_store_release(pvm_g2h_word(PVM_G2H_REQUEST_PRODUCER),
			  ++pvm_request_producer);
	mb();
	*notify |= pvm_sock_need_event(
		smp_load_acquire(pvm_h2g_word(PVM_H2G_REQUEST_EVENT)),
		pvm_request_producer, old_producer);
	return 0;
}

/* Caller owns pvm_ring_lock. The child capability and pending identity are
 * independently generation checked by the host. */
static int pvm_publish_ingress_accept_locked(
	struct pvm_sock *child, const struct pvm_ingress_offer *offer,
	bool *notify)
{
	struct pvm_sock_desc *ring;
	u32 old_producer = pvm_request_producer;
	struct pvm_sock_desc descriptor = {
		.version = cpu_to_le16(PVM_SOCK_ABI_VERSION),
		.opcode = cpu_to_le16(PVM_CMD_INGRESS_ACCEPT),
		.capability = cpu_to_le32(child->capability),
		.generation = cpu_to_le64(child->generation),
		.slot = cpu_to_le16(offer->index),
		.offset = cpu_to_le32((u32)offer->generation),
		.length = cpu_to_le32((u32)(offer->generation >> 32)),
		.sequence = cpu_to_le32(++child->sequence),
	};

	if (!pvm_request_has_space())
		return -EAGAIN;
	ring = (void *)((u8 *)pvm_g2h + PVM_SOCK_DESC_OFFSET);
	memcpy(&ring[pvm_request_producer % PVM_SOCK_RING_ENTRIES],
	       &descriptor, sizeof(descriptor));
	smp_store_release(pvm_g2h_word(PVM_G2H_REQUEST_PRODUCER),
			  ++pvm_request_producer);
	mb();
	*notify |= pvm_sock_need_event(
		smp_load_acquire(pvm_h2g_word(PVM_H2G_REQUEST_EVENT)),
		pvm_request_producer, old_producer);
	return 0;
}

static int pvm_wait_ring(long *timeout)
{
	long result;

	if (pvm_request_has_space())
		return 0;
	if (!*timeout)
		return -EAGAIN;
	pvm_arm_request_credit();
	if (pvm_request_has_space())
		return 0;
	result = wait_event_interruptible_timeout(
		pvm_ring_wait, pvm_request_has_space() || pvm_protocol_fault,
		*timeout);
	if (result < 0)
		return result;
	if (!result)
		return -EAGAIN;
	*timeout = result;
	return pvm_protocol_fault ? -EPROTO : 0;
}

static void pvm_flush_notify(bool *notify)
{
	if (!notify || !*notify)
		return;
	*notify = false;
	pvm_sock_notify();
}

static int pvm_submit_deferred(struct pvm_sock *ps, u16 opcode, u16 slot,
			       u32 offset, u32 length, bool nonblock,
			       bool *notify)
{
	long timeout = sock_sndtimeo(&ps->sk, nonblock);
	int error;

	for (;;) {
		spin_lock_irq(&pvm_ring_lock);
		error = pvm_publish_locked(ps, opcode, slot, offset, length,
					   notify);
		spin_unlock_irq(&pvm_ring_lock);
		if (error != -EAGAIN)
			break;
		/*
		 * Earlier descriptors may be the only work that can return ring
		 * credit. Doorbell them before sleeping on a full request ring.
		 */
		pvm_flush_notify(notify);
		error = pvm_wait_ring(&timeout);
		if (error)
			return error;
	}
	if (!error &&
	    (opcode == PVM_CMD_CONNECT || opcode == PVM_CMD_DNS_QUERY))
		ps->broker_opened = true;
	return error;
}

static int pvm_submit(struct pvm_sock *ps, u16 opcode, u16 slot,
		      u32 offset, u32 length, bool nonblock)
{
	bool notify = false;
	int error;

	error = pvm_submit_deferred(ps, opcode, slot, offset, length,
				    nonblock, &notify);
	pvm_flush_notify(&notify);
	return error;
}

static int pvm_submit_ingress_accept(
	struct pvm_sock *child, const struct pvm_ingress_offer *offer,
	bool nonblock)
{
	long timeout = sock_sndtimeo(&child->sk, nonblock);
	bool notify = false;
	int error;

	for (;;) {
		spin_lock_irq(&pvm_ring_lock);
		error = pvm_publish_ingress_accept_locked(child, offer,
							 &notify);
		spin_unlock_irq(&pvm_ring_lock);
		if (error != -EAGAIN)
			break;
		pvm_flush_notify(&notify);
		error = pvm_wait_ring(&timeout);
		if (error)
			return error;
	}
	pvm_flush_notify(&notify);
	if (!error)
		child->broker_opened = true;
	return error;
}

static void pvm_fail_all_locked(int error)
{
	unsigned int index;

	pvm_protocol_fault = true;
	for (index = 0; index < PVM_SOCK_CAPABILITIES; index++) {
		struct pvm_sock *ps = pvm_capability_socket[index];

		if (!ps)
			continue;
		ps->error = error;
		WRITE_ONCE(ps->sk.sk_err, error);
		wake_up_interruptible(sk_sleep(&ps->sk));
	}
	wake_up_interruptible(&pvm_tx_wait);
	wake_up_interruptible(&pvm_ring_wait);
}

/* Caller owns pvm_ring_lock. */
static int pvm_take_tx_slot_locked(struct pvm_sock *ps)
{
	int slot;

	if (ps->tx_inflight >= PVM_SOCK_CONNECTION_SLOTS)
		return -1;
	slot = find_first_zero_bit(pvm_tx_busy, PVM_SOCK_SLOT_COUNT);
	if (slot >= PVM_SOCK_SLOT_COUNT)
		return -1;
	__set_bit(slot, pvm_tx_busy);
	pvm_tx_capability[slot] = ps->capability;
	pvm_tx_generation[slot] = ps->generation;
	ps->tx_inflight++;
	return slot;
}

/* Caller owns pvm_ring_lock. Waiters are stack-resident until granted/removed. */
static void pvm_grant_tx_waiters_locked(void)
{
	struct pvm_tx_waiter *waiter;
	struct pvm_tx_waiter *next;
	bool granted = false;

	list_for_each_entry_safe(waiter, next, &pvm_tx_waiters, node) {
		int slot = pvm_take_tx_slot_locked(waiter->ps);

		if (slot < 0) {
			if (find_first_zero_bit(pvm_tx_busy,
						PVM_SOCK_SLOT_COUNT) >=
			    PVM_SOCK_SLOT_COUNT)
				break;
			continue;
		}
		waiter->slot = slot;
		WRITE_ONCE(waiter->granted, true);
		list_del_init(&waiter->node);
		granted = true;
	}
	if (granted)
		wake_up_interruptible(&pvm_tx_wait);
}

static void pvm_clear_tx_locked(unsigned int slot, u32 capability,
				u64 generation)
{
	struct pvm_sock *ps;

	if (slot >= PVM_SOCK_SLOT_COUNT ||
	    !test_bit(slot, pvm_tx_busy) ||
	    pvm_tx_capability[slot] != capability ||
	    pvm_tx_generation[slot] != generation)
		return;
	__clear_bit(slot, pvm_tx_busy);
	pvm_tx_capability[slot] = 0;
	pvm_tx_generation[slot] = 0;
	ps = pvm_capability_socket[capability];
	if (ps && ps->generation == generation && ps->tx_inflight)
		ps->tx_inflight--;
	pvm_grant_tx_waiters_locked();
	wake_up_interruptible(&pvm_tx_wait);
}

static bool pvm_single_stream_sender(void)
{
	return atomic_read(&pvm_stream_senders) <= 1;
}

/* Caller owns pvm_ring_lock. Host CLOSED is the capability reuse fence. */
static void pvm_finish_capability_close_locked(u32 capability, u64 generation)
{
	struct pvm_sock *ps;

	if (capability >= PVM_SOCK_CAPABILITIES ||
	    pvm_capability_closing[capability] != generation ||
	    pvm_capability_generation[capability] != generation)
		return;
	pvm_capability_closing[capability] = 0;
	ps = pvm_capability_socket[capability];
	if (ps && ps->generation == generation)
		pvm_capability_socket[capability] = NULL;
	if (generation == U64_MAX)
		return; /* Permanently busy rather than wrap a stale capability. */
	pvm_capability_generation[capability] = generation + 1;
	__clear_bit(capability, pvm_capability_busy);
}

static int pvm_ensure_capability(struct pvm_sock *ps)
{
	unsigned int capability;

	if (READ_ONCE(ps->capability_allocated))
		return 0;
	if (READ_ONCE(pvm_protocol_fault))
		return -EPROTO;
	spin_lock_irq(&pvm_ring_lock);
	if (ps->capability_allocated) {
		spin_unlock_irq(&pvm_ring_lock);
		return 0;
	}
	capability = find_first_zero_bit(pvm_capability_busy,
					 PVM_SOCK_CAPABILITIES);
	if (capability == PVM_SOCK_CAPABILITIES) {
		spin_unlock_irq(&pvm_ring_lock);
		return -EMFILE;
	}
	__set_bit(capability, pvm_capability_busy);
	ps->capability = capability;
	ps->generation = pvm_capability_generation[capability];
	ps->capability_allocated = true;
	pvm_capability_socket[capability] = ps;
	spin_unlock_irq(&pvm_ring_lock);
	return 0;
}

/* Caller owns pvm_ring_lock. TCP and datagram delivery both preserve FIFO. */
static bool pvm_queue_rx_locked(struct pvm_sock *ps, u16 slot)
{
	u8 tail;

	if (ps->rx_count >= PVM_SOCK_CONNECTION_SLOTS)
		return false;
	tail = (ps->rx_head + ps->rx_count) % PVM_SOCK_CONNECTION_SLOTS;
	ps->rx_queue[tail] = slot;
	ps->rx_count++;
	return true;
}

/* Caller owns pvm_ring_lock. The registry and every queue are hard bounded so
 * a hostile guest process cannot turn one host offer IRQ into unbounded work. */
static bool pvm_ingress_exists_locked(u16 index, u64 generation)
{
	struct pvm_sock *listener;

	list_for_each_entry(listener, &pvm_listeners, listener_node) {
		unsigned int offset;

		for (offset = 0; offset < listener->ingress_count; offset++) {
			unsigned int position =
				(listener->ingress_head + offset) %
				PVM_SOCK_LISTENER_INGRESS;
			struct pvm_ingress_offer *offer =
				&listener->ingress[position];

			if (offer->index == index &&
			    offer->generation == generation)
				return true;
		}
	}
	return false;
}

static struct pvm_sock *pvm_find_ingress_listener_locked(
	const struct sockaddr_in *target)
{
	struct pvm_sock *listener;
	struct pvm_sock *exact = NULL;
	struct pvm_sock *wildcard = NULL;
	unsigned int exact_count = 0;
	unsigned int wildcard_count = 0;

	list_for_each_entry(listener, &pvm_listeners, listener_node) {
		if (!listener->listening ||
		    listener->bound.sin_port != target->sin_port)
			continue;
		if (listener->bound.sin_addr.s_addr == target->sin_addr.s_addr) {
			exact = listener;
			exact_count++;
		} else if (listener->bound.sin_addr.s_addr == htonl(INADDR_ANY)) {
			wildcard = listener;
			wildcard_count++;
		}
	}
	if (exact_count)
		return exact_count == 1 ? exact : NULL;
	return wildcard_count == 1 ? wildcard : NULL;
}

static void pvm_handle_ingress_offer_locked(
	const struct pvm_sock_event *event, bool *notify)
{
	u32 index = le32_to_cpu(event->capability);
	u64 generation = le64_to_cpu(event->generation);
	u16 target_port = le16_to_cpu(event->slot);
	u32 target_address = le32_to_cpu(event->status);
	u32 peer_address = le32_to_cpu(event->length);
	u32 peer_port = le32_to_cpu(event->sequence);
	struct pvm_sock *listener;
	struct pvm_ingress_offer *offer;
	unsigned int tail;

	if (index >= PVM_SOCK_INGRESS_SLOTS || !generation || !target_port ||
	    target_address != 0x7f000001U || !peer_port || peer_port > U16_MAX ||
	    pvm_ingress_exists_locked(index, generation)) {
		pvm_fail_all_locked(EPROTO);
		return;
	}
	listener = pvm_find_ingress_listener_locked(&(struct sockaddr_in) {
		.sin_family = AF_INET,
		.sin_port = htons(target_port),
		.sin_addr.s_addr = htonl(target_address),
	});
	if (!listener || listener->ingress_count >= listener->ingress_limit) {
		(void)pvm_publish_ingress_reply_locked(PVM_CMD_INGRESS_REJECT,
							index, generation, notify);
		return;
	}
	/* Publish ACK before making the offer visible to accept(2). If the guest
	 * command ring is saturated, the host times out and no stale readiness is
	 * installed in the listener. */
	if (pvm_publish_ingress_reply_locked(PVM_CMD_INGRESS_ACK, index,
						generation, notify))
		return;
	tail = (listener->ingress_head + listener->ingress_count) %
	       PVM_SOCK_LISTENER_INGRESS;
	offer = &listener->ingress[tail];
	memset(offer, 0, sizeof(*offer));
	offer->index = index;
	offer->generation = generation;
	offer->local.sin_family = AF_INET;
	offer->local.sin_port = htons(target_port);
	offer->local.sin_addr.s_addr = htonl(target_address);
	offer->peer.sin_family = AF_INET;
	offer->peer.sin_port = htons(peer_port);
	offer->peer.sin_addr.s_addr = htonl(peer_address);
	listener->ingress_count++;
	wake_up_interruptible_poll(sk_sleep(&listener->sk),
				   EPOLLIN | EPOLLRDNORM);
}

static void pvm_handle_ingress_cancel_locked(
	const struct pvm_sock_event *event)
{
	u32 index = le32_to_cpu(event->capability);
	u64 generation = le64_to_cpu(event->generation);
	struct pvm_sock *listener;

	if (index >= PVM_SOCK_INGRESS_SLOTS || !generation ||
	    le16_to_cpu(event->slot) || le32_to_cpu(event->status) ||
	    le32_to_cpu(event->length) || le32_to_cpu(event->sequence)) {
		pvm_fail_all_locked(EPROTO);
		return;
	}
	list_for_each_entry(listener, &pvm_listeners, listener_node) {
		struct pvm_ingress_offer retained[PVM_SOCK_LISTENER_INGRESS];
		unsigned int retained_count = 0;
		unsigned int offset;
		bool removed = false;

		for (offset = 0; offset < listener->ingress_count; offset++) {
			struct pvm_ingress_offer offer =
				listener->ingress[(listener->ingress_head + offset) %
						  PVM_SOCK_LISTENER_INGRESS];

			if (offer.index == index && offer.generation == generation)
				removed = true;
			else
				retained[retained_count++] = offer;
		}
		if (!removed)
			continue;
		memcpy(listener->ingress, retained,
		       retained_count * sizeof(retained[0]));
		listener->ingress_head = 0;
		listener->ingress_count = retained_count;
		wake_up_interruptible(sk_sleep(&listener->sk));
		return;
	}
}

/* Caller owns pvm_ring_lock and has copied the untrusted event privately. */
static void pvm_handle_event_locked(const struct pvm_sock_event *event,
				    bool *notify)
{
	u32 capability = le32_to_cpu(event->capability);
	u64 generation = le64_to_cpu(event->generation);
	u16 kind = le16_to_cpu(event->kind);
	u16 slot = le16_to_cpu(event->slot);
	u32 length = le32_to_cpu(event->length);
	s32 status = (s32)le32_to_cpu(event->status);
	struct pvm_sock *ps;

	if (le16_to_cpu(event->version) != PVM_SOCK_ABI_VERSION ||
	    le16_to_cpu(event->flags))
		goto protocol_fault;
	if (kind == PVM_EVENT_INGRESS_OFFER) {
		pvm_handle_ingress_offer_locked(event, notify);
		return;
	}
	if (kind == PVM_EVENT_INGRESS_CANCEL) {
		pvm_handle_ingress_cancel_locked(event);
		return;
	}
	if (capability >= PVM_SOCK_CAPABILITIES || !generation)
		goto protocol_fault;
	if (kind == PVM_EVENT_CONNECTED || kind == PVM_EVENT_TX_COMPLETE ||
	    kind == PVM_EVENT_DNS_TX_COMPLETE ||
	    ((kind == PVM_EVENT_ERROR || kind == PVM_EVENT_CLOSED) &&
	     (length == PVM_CMD_CONNECT || length == PVM_CMD_TX ||
	      length == PVM_CMD_DNS_QUERY)))
		pvm_clear_tx_locked(slot, capability, generation);
	ps = pvm_capability_socket[capability];
	if ((kind == PVM_EVENT_CLOSED ||
	     (kind == PVM_EVENT_ERROR && length == PVM_CMD_CLOSE)) &&
	    pvm_capability_closing[capability] == generation) {
		if (ps && ps->generation == generation) {
			ps->peer_closed = true;
			if (status < 0) {
				ps->error = -status;
				WRITE_ONCE(ps->sk.sk_err, ps->error);
			}
			wake_up_interruptible(sk_sleep(&ps->sk));
		}
		pvm_finish_capability_close_locked(capability, generation);
		return;
	}
	if (!ps || ps->generation != generation)
		return; /* stale completion after close */

	switch (kind) {
	case PVM_EVENT_CONNECTED:
		if (slot >= PVM_SOCK_SLOT_COUNT || ps->datagram)
			goto protocol_fault;
		ps->connected = true;
		ps->sk.sk_socket->state = SS_CONNECTED;
		wake_up_interruptible(sk_sleep(&ps->sk));
		break;
	case PVM_EVENT_TX_COMPLETE:
		if (slot >= PVM_SOCK_SLOT_COUNT || ps->datagram)
			goto protocol_fault;
		wake_up_interruptible(sk_sleep(&ps->sk));
		break;
	case PVM_EVENT_DNS_TX_COMPLETE:
		if (slot >= PVM_SOCK_SLOT_COUNT || !ps->datagram)
			goto protocol_fault;
		wake_up_interruptible(sk_sleep(&ps->sk));
		break;
	case PVM_EVENT_RX_READY:
		if (slot >= PVM_SOCK_SLOT_COUNT || !length ||
		    length > PVM_SOCK_SLOT_SIZE || pvm_rx_owner[slot] ||
		    ps->datagram || !pvm_queue_rx_locked(ps, slot))
			goto protocol_fault;
		pvm_rx_owner[slot] = ps;
		pvm_rx_length[slot] = length;
		pvm_rx_offset[slot] = 0;
		wake_up_interruptible(sk_sleep(&ps->sk));
		break;
	case PVM_EVENT_DNS_RX_READY:
		if (slot >= PVM_SOCK_SLOT_COUNT || !length ||
		    length > PVM_DNS_RESPONSE_MAX || pvm_rx_owner[slot] ||
		    !ps->datagram || !pvm_queue_rx_locked(ps, slot))
			goto protocol_fault;
		pvm_rx_owner[slot] = ps;
		pvm_rx_length[slot] = length;
		pvm_rx_offset[slot] = 0;
		wake_up_interruptible(sk_sleep(&ps->sk));
		break;
	case PVM_EVENT_INGRESS_ACCEPTED:
		if (ps->datagram || ps->transport != PVM_TRANSPORT_BROKER)
			goto protocol_fault;
		ps->connected = true;
		ps->sk.sk_socket->state = SS_CONNECTED;
		wake_up_interruptible(sk_sleep(&ps->sk));
		break;
	case PVM_EVENT_SHUTDOWN:
		if (length > SHUT_RDWR)
			goto protocol_fault;
		if (length != SHUT_WR)
			ps->peer_closed = true;
		if (length != SHUT_RD)
			WRITE_ONCE(ps->sk.sk_shutdown,
				   READ_ONCE(ps->sk.sk_shutdown) |
				   SEND_SHUTDOWN);
		wake_up_interruptible(sk_sleep(&ps->sk));
		break;
	case PVM_EVENT_CLOSED:
		ps->peer_closed = true;
		if (status < 0) {
			ps->error = -status;
			WRITE_ONCE(ps->sk.sk_err, ps->error);
		}
		wake_up_interruptible(sk_sleep(&ps->sk));
		break;
	case PVM_EVENT_ERROR:
		ps->error = status < 0 ? -status : EPROTO;
		WRITE_ONCE(ps->sk.sk_err, ps->error);
		wake_up_interruptible(sk_sleep(&ps->sk));
		break;
	default:
		goto protocol_fault;
	}
	return;

protocol_fault:
	pvm_fail_all_locked(EPROTO);
}

static irqreturn_t pvm_socket_irq(int irq, void *opaque)
{
	struct pvm_sock_event *ring;
	u32 published;
	u32 available;
	u32 old_consumer;
	u32 credit_event;
	unsigned int drained = 0;
	bool notify_credit;
	bool notify_host = false;

	(void)irq;
	(void)opaque;
	spin_lock(&pvm_ring_lock);
	old_consumer = pvm_response_consumer;
	ring = (void *)((u8 *)pvm_h2g + PVM_SOCK_DESC_OFFSET);
	for (;;) {
		published = smp_load_acquire(
			pvm_h2g_word(PVM_H2G_RESPONSE_PRODUCER));
		available = published - pvm_response_consumer;
		if (available > PVM_SOCK_RING_ENTRIES) {
			pvm_fail_all_locked(EPROTO);
			spin_unlock(&pvm_ring_lock);
			return IRQ_HANDLED;
		}
		while (available && drained < PVM_SOCK_DRAIN_BUDGET) {
			struct pvm_sock_event event;

			memcpy(&event,
			       &ring[pvm_response_consumer %
				     PVM_SOCK_RING_ENTRIES],
			       sizeof(event));
			pvm_handle_event_locked(&event, &notify_host);
			pvm_response_consumer++;
			available--;
			drained++;
		}
		/* Arm before publishing credit. If the ring was full, the host
		 * cannot refill it until the following consumer store. */
		smp_store_release(pvm_g2h_word(PVM_G2H_RESPONSE_EVENT),
				  pvm_response_consumer);
		mb();
		if (drained == PVM_SOCK_DRAIN_BUDGET ||
		    smp_load_acquire(
			    pvm_h2g_word(PVM_H2G_RESPONSE_PRODUCER)) ==
			    pvm_response_consumer)
			break;
	}
	smp_store_release(pvm_g2h_word(PVM_G2H_RESPONSE_CONSUMER),
				  pvm_response_consumer);
	/* Publish returned credit before sampling the host's credit event. */
	mb();
	credit_event = smp_load_acquire(
		pvm_h2g_word(PVM_H2G_RESPONSE_CREDIT_EVENT));
	notify_credit = pvm_sock_need_event(credit_event, pvm_response_consumer,
					    old_consumer);
	spin_unlock(&pvm_ring_lock);
	wake_up_interruptible(&pvm_ring_wait);
	if (notify_credit || notify_host)
		pvm_sock_notify();
	return IRQ_HANDLED;
}

static int pvm_alloc_tx_slot_deferred(struct pvm_sock *ps, bool nonblock,
				      bool *notify)
{
	struct pvm_tx_waiter waiter = {
		.ps = ps,
		.slot = -1,
	};
	long timeout = sock_sndtimeo(&ps->sk, nonblock);
	long result;
	int error;

	error = pvm_ensure_capability(ps);
	if (error)
		return error;
	INIT_LIST_HEAD(&waiter.node);
	spin_lock_irq(&pvm_ring_lock);
	/* Give every older eligible waiter first refusal. Waiters already at
	 * their per-connection limit do not idle unrelated global slots. */
	pvm_grant_tx_waiters_locked();
	waiter.slot = pvm_take_tx_slot_locked(ps);
	if (waiter.slot >= 0) {
		spin_unlock_irq(&pvm_ring_lock);
		return waiter.slot;
	}
	if (!timeout) {
		spin_unlock_irq(&pvm_ring_lock);
		pvm_flush_notify(notify);
		return -EAGAIN;
	}
	list_add_tail(&waiter.node, &pvm_tx_waiters);
	pvm_grant_tx_waiters_locked();
	spin_unlock_irq(&pvm_ring_lock);
	/*
	 * The pending descriptors are what will eventually grant this waiter.
	 * Publish one accumulated doorbell only after the waiter is visible.
	 */
	pvm_flush_notify(notify);

	for (;;) {
		result = wait_event_interruptible_timeout(
			pvm_tx_wait, READ_ONCE(waiter.granted) ||
			pvm_protocol_fault,
			timeout);

		spin_lock_irq(&pvm_ring_lock);
		if (waiter.granted) {
			spin_unlock_irq(&pvm_ring_lock);
			return waiter.slot;
		}
		if (pvm_protocol_fault)
			error = -EPROTO;
		else if (result < 0)
			error = result;
		else if (!result)
			error = -EAGAIN;
		else {
			timeout = result;
			spin_unlock_irq(&pvm_ring_lock);
			continue;
		}
		if (!list_empty(&waiter.node)) {
			list_del_init(&waiter.node);
			pvm_grant_tx_waiters_locked();
		}
		spin_unlock_irq(&pvm_ring_lock);
		return error;
	}
}

static int pvm_alloc_tx_slot(struct pvm_sock *ps, bool nonblock)
{
	return pvm_alloc_tx_slot_deferred(ps, nonblock, NULL);
}

static int pvm_init_outer_socket(struct net *net, struct socket *sock,
				 bool datagram, int kern)
{
	struct proto *provider = datagram ? &pvm_datagram_proto :
						   &pvm_stream_proto;
	const struct proto_ops *operations = datagram ? &pvm_datagram_ops :
							&pvm_stream_ops;
	struct sock *sk;
	struct pvm_sock *ps;

	sk = sk_alloc(net, PF_INET, GFP_KERNEL, provider, kern);
	if (!sk)
		return -ENOMEM;
	ps = pvm_sk(sk);
	INIT_LIST_HEAD(&ps->listener_node);
	ps->datagram = datagram;
	ps->transport = datagram ? PVM_TRANSPORT_BROKER : PVM_TRANSPORT_NONE;
	sock->ops = operations;
	sock_init_data(sock, sk);
	sock->state = SS_UNCONNECTED;
	return 0;
}

static int pvm_select_local(struct pvm_sock *ps)
{
	int error;

	lock_sock(&ps->sk);
	if (ps->transport == PVM_TRANSPORT_BROKER) {
		error = -EISCONN;
		goto out;
	}
	if (ps->transport == PVM_TRANSPORT_LOCAL) {
		error = 0;
		goto out;
	}
	error = pvm_local_open(&ps->local, sock_net(&ps->sk), SOCK_STREAM,
			       IPPROTO_TCP, &ps->sk, ps->tcp_nodelay);
	if (!error) {
		ps->transport = PVM_TRANSPORT_LOCAL;
		/* epoll may have observed the stable facade before its native
		 * backend existed. Force one re-poll; the callback bridge will
		 * mirror later asynchronous connect/listen events onto this queue.
		 */
		wake_up_interruptible_poll(sk_sleep(&ps->sk),
					   EPOLLIN | EPOLLOUT | EPOLLERR);
	}
out:
	release_sock(&ps->sk);
	return error;
}

static int pvm_select_broker(struct pvm_sock *ps)
{
	int error = 0;

	lock_sock(&ps->sk);
	if (ps->transport == PVM_TRANSPORT_LOCAL)
		error = -EISCONN;
	else
		ps->transport = PVM_TRANSPORT_BROKER;
	release_sock(&ps->sk);
	return error;
}

static bool pvm_is_loopback_address(const struct sockaddr *address,
				    int address_length)
{
	const struct sockaddr_in *ipv4 = (const struct sockaddr_in *)address;

	return address_length >= sizeof(*ipv4) && ipv4->sin_family == AF_INET &&
	       ipv4_is_loopback(ipv4->sin_addr.s_addr);
}

static bool pvm_is_local_bind_address(const struct sockaddr *address,
				      int address_length)
{
	const struct sockaddr_in *ipv4 = (const struct sockaddr_in *)address;

	return address_length >= sizeof(*ipv4) && ipv4->sin_family == AF_INET &&
	       (ipv4->sin_addr.s_addr == htonl(INADDR_ANY) ||
		ipv4_is_loopback(ipv4->sin_addr.s_addr));
}

static int pvm_stream_connect(struct socket *sock, struct sockaddr *address,
			      int address_length, int flags)
{
	struct sock *sk = sock->sk;
	struct pvm_sock *ps = pvm_sk(sk);
	struct sockaddr_in *peer = (struct sockaddr_in *)address;
	struct pvm_sock_endpoint4 endpoint;
	bool nonblock = flags & O_NONBLOCK;
	long timeout;
	int slot;
	long result;

	if (address_length < sizeof(*peer) || peer->sin_family != AF_INET)
		return -EINVAL;
	if (sock->state != SS_UNCONNECTED)
		return -EISCONN;
	if (pvm_is_loopback_address(address, address_length)) {
		result = pvm_select_local(ps);
		if (result)
			return result;
		result = pvm_local_connect(&ps->local, address, address_length,
					   flags);
		sock->state = ps->local.inner->state;
		if (!result)
			ps->connected = true;
		return result;
	}
	if (!peer->sin_port)
		return -EINVAL;
	result = pvm_select_broker(ps);
	if (result)
		return result;
	slot = pvm_alloc_tx_slot(ps, nonblock);
	if (slot < 0)
		return slot;
	endpoint.family = cpu_to_le16(AF_INET);
	endpoint.port = peer->sin_port;
	endpoint.address = peer->sin_addr.s_addr;
	memcpy(pvm_tx_slot(slot), &endpoint, sizeof(endpoint));
	ps->peer = *peer;
	sock->state = SS_CONNECTING;
	result = pvm_submit(ps, PVM_CMD_CONNECT, slot, 0,
			    sizeof(endpoint), nonblock);
	if (result) {
		spin_lock_irq(&pvm_ring_lock);
		pvm_clear_tx_locked(slot, ps->capability, ps->generation);
		spin_unlock_irq(&pvm_ring_lock);
		sock->state = SS_UNCONNECTED;
		return result;
	}
	if (nonblock)
		return -EINPROGRESS;
	timeout = sock_sndtimeo(sk, false);
	result = wait_event_interruptible_timeout(
		*sk_sleep(sk), READ_ONCE(ps->connected) || READ_ONCE(ps->error) ||
		READ_ONCE(ps->peer_closed) || pvm_protocol_fault, timeout);
	if (result < 0)
		return result;
	if (!result)
		return -ETIMEDOUT;
	if (ps->error)
		return -ps->error;
	return ps->connected ? 0 : -ECONNREFUSED;
}

static int pvm_stream_bind(struct socket *sock, struct sockaddr *address,
			   int address_length)
{
	struct pvm_sock *ps = pvm_sk(sock->sk);
	int error;

	if (address_length < sizeof(sa_family_t) ||
	    address->sa_family != AF_INET)
		return -EINVAL;
	if (!pvm_is_local_bind_address(address, address_length))
		return -EADDRNOTAVAIL;
	error = pvm_select_local(ps);
	if (error)
		return error;
	error = pvm_local_bind(&ps->local, address, address_length);
	if (!error)
		(void)pvm_local_getname(&ps->local,
					(void *)&ps->bound, 0);
	return error;
}

static int pvm_reserve_listener(struct pvm_sock *ps)
{
	spin_lock_irq(&pvm_ring_lock);
	if (!list_empty(&ps->listener_node)) {
		spin_unlock_irq(&pvm_ring_lock);
		return 0;
	}
	if (pvm_listener_count >= PVM_SOCK_LISTENERS) {
		spin_unlock_irq(&pvm_ring_lock);
		return -ENOSPC;
	}
	list_add_tail(&ps->listener_node, &pvm_listeners);
	pvm_listener_count++;
	spin_unlock_irq(&pvm_ring_lock);
	return 0;
}

static void pvm_register_listener(struct pvm_sock *ps, int backlog)
{
	spin_lock_irq(&pvm_ring_lock);
	ps->listening = true;
	ps->ingress_limit = backlog <= 0 ? 1 :
		min_t(unsigned int, backlog, PVM_SOCK_LISTENER_INGRESS);
	if (list_empty(&ps->listener_node)) {
		/* pvm_reserve_listener() makes every successful listener visible
		 * to ingress lookup; silently untracked listeners are forbidden. */
		list_add_tail(&ps->listener_node, &pvm_listeners);
		pvm_listener_count++;
	}
	spin_unlock_irq(&pvm_ring_lock);
}

static void pvm_unregister_listener(struct pvm_sock *ps)
{
	bool notify = false;
	unsigned int offset;

	spin_lock_irq(&pvm_ring_lock);
	ps->listening = false;
	if (!list_empty(&ps->listener_node)) {
		list_del_init(&ps->listener_node);
		pvm_listener_count--;
	}
	for (offset = 0; offset < ps->ingress_count; offset++) {
		struct pvm_ingress_offer *offer =
			&ps->ingress[(ps->ingress_head + offset) %
				     PVM_SOCK_LISTENER_INGRESS];

		(void)pvm_publish_ingress_reply_locked(PVM_CMD_INGRESS_REJECT,
				offer->index, offer->generation, &notify);
	}
	ps->ingress_head = 0;
	ps->ingress_count = 0;
	spin_unlock_irq(&pvm_ring_lock);
	pvm_flush_notify(&notify);
}

static bool pvm_take_ingress(struct pvm_sock *listener,
			     struct pvm_ingress_offer *offer)
{
	spin_lock_irq(&pvm_ring_lock);
	if (!listener->ingress_count) {
		spin_unlock_irq(&pvm_ring_lock);
		return false;
	}
	*offer = listener->ingress[listener->ingress_head];
	listener->ingress_head = (listener->ingress_head + 1) %
				 PVM_SOCK_LISTENER_INGRESS;
	listener->ingress_count--;
	spin_unlock_irq(&pvm_ring_lock);
	return true;
}

static void pvm_reject_ingress(const struct pvm_ingress_offer *offer)
{
	bool notify = false;

	spin_lock_irq(&pvm_ring_lock);
	(void)pvm_publish_ingress_reply_locked(PVM_CMD_INGRESS_REJECT,
			offer->index, offer->generation, &notify);
	spin_unlock_irq(&pvm_ring_lock);
	pvm_flush_notify(&notify);
}

static int pvm_stream_listen(struct socket *sock, int backlog)
{
	struct pvm_sock *ps = pvm_sk(sock->sk);
	int error;

	error = pvm_select_local(ps);
	if (error)
		return error;
	error = pvm_reserve_listener(ps);
	if (error)
		return error;
	error = pvm_local_listen(&ps->local, backlog);
	if (error) {
		pvm_unregister_listener(ps);
		return error;
	}
	(void)pvm_local_getname(&ps->local, (void *)&ps->bound, 0);
	pvm_register_listener(ps, backlog);
	return 0;
}

static int pvm_accept_local(struct socket *sock, struct socket *newsock,
			    int flags, bool kern)
{
	struct pvm_sock *listener = pvm_sk(sock->sk);
	struct pvm_local_socket accepted = {};
	struct pvm_sock *child;
	int error;

	error = pvm_local_accept(&listener->local, &accepted,
				 flags | O_NONBLOCK);
	if (error)
		return error;
	error = pvm_init_outer_socket(sock_net(sock->sk), newsock, false, kern);
	if (error) {
		pvm_local_release(&accepted);
		return error;
	}
	child = pvm_sk(newsock->sk);
	pvm_local_adopt(&child->local, accepted.inner, &child->sk);
	accepted.inner = NULL;
	child->transport = PVM_TRANSPORT_LOCAL;
	child->connected = true;
	newsock->state = SS_CONNECTED;
	listener->accept_broker_turn = true;
	return 0;
}

static int pvm_accept_ingress(struct socket *sock, struct socket *newsock,
			      int flags, bool kern)
{
	struct pvm_sock *listener = pvm_sk(sock->sk);
	struct pvm_ingress_offer offer;
	struct pvm_sock *child;
	int error;

	if (!pvm_take_ingress(listener, &offer))
		return -EAGAIN;
	error = pvm_init_outer_socket(sock_net(sock->sk), newsock, false, kern);
	if (error) {
		pvm_reject_ingress(&offer);
		return error;
	}
	child = pvm_sk(newsock->sk);
	error = pvm_ensure_capability(child);
	if (error)
		goto fail;
	child->transport = PVM_TRANSPORT_BROKER;
	child->bound = offer.local;
	child->peer = offer.peer;
	child->connected = true;
	newsock->state = SS_CONNECTED;
	error = pvm_submit_ingress_accept(child, &offer,
					  flags & O_NONBLOCK);
	if (error)
		goto fail;
	listener->accept_broker_turn = false;
	return 0;

fail:
	pvm_reject_ingress(&offer);
	pvm_release(newsock);
	return error;
}

static int pvm_stream_accept(struct socket *sock, struct socket *newsock,
			     int flags, bool kern)
{
	struct pvm_sock *listener = pvm_sk(sock->sk);
	long timeout;
	long result;
	int error;

	if (listener->transport != PVM_TRANSPORT_LOCAL)
		return -EINVAL;
	timeout = sock_rcvtimeo(sock->sk, flags & O_NONBLOCK);
	for (;;) {
		if (listener->accept_broker_turn) {
			error = pvm_accept_ingress(sock, newsock, flags, kern);
			if (error != -EAGAIN)
				return error;
			error = pvm_accept_local(sock, newsock, flags, kern);
		} else {
			error = pvm_accept_local(sock, newsock, flags, kern);
			if (error == -EAGAIN)
				error = pvm_accept_ingress(sock, newsock, flags, kern);
		}
		if (error != -EAGAIN)
			return error;
		if (!timeout)
			return -EAGAIN;
		result = wait_event_interruptible_timeout(
			*sk_sleep(sock->sk),
			READ_ONCE(listener->ingress_count) ||
			pvm_local_accept_ready(&listener->local) ||
			READ_ONCE(pvm_protocol_fault), timeout);
		if (result < 0)
			return result;
		if (!result)
			return -EAGAIN;
		if (pvm_protocol_fault)
			return -EPROTO;
		timeout = result;
	}
}

static int pvm_datagram_connect(struct socket *sock, struct sockaddr *address,
				int address_length, int flags)
{
	struct pvm_sock *ps = pvm_sk(sock->sk);
	struct sockaddr_in *peer = (struct sockaddr_in *)address;

	(void)flags;
	if (address_length < sizeof(sa_family_t))
		return -EINVAL;
	if (peer->sin_family == AF_UNSPEC) {
		memset(&ps->peer, 0, sizeof(ps->peer));
		ps->connected = false;
		sock->state = SS_UNCONNECTED;
		return 0;
	}
	if (address_length < sizeof(*peer) || peer->sin_family != AF_INET ||
	    ntohs(peer->sin_port) != PVM_DNS_PORT)
		return -EACCES;
	ps->peer = *peer;
	ps->connected = true;
	sock->state = SS_CONNECTED;
	return 0;
}

/*
 * libc resolvers bind an unprivileged UDP socket to INADDR_ANY:0 before
 * sendto(2). The host broker already creates one fresh ephemeral UDP socket
 * per capability, so this exact bind has no additional host-side effect.
 */
static int pvm_datagram_bind(struct socket *sock, struct sockaddr *address,
			     int address_length)
{
	struct sockaddr_in *local = (struct sockaddr_in *)address;

	(void)sock;
	if (address_length < sizeof(*local) || local->sin_family != AF_INET)
		return -EINVAL;
	if (local->sin_addr.s_addr != htonl(INADDR_ANY) || local->sin_port)
		return -EACCES;
	return 0;
}

static int pvm_stream_sendmsg(struct socket *sock, struct msghdr *message,
			      size_t total_length)
{
	struct pvm_sock *ps = pvm_sk(sock->sk);
	bool nonblock = message->msg_flags & MSG_DONTWAIT;
	bool notify = false;
	size_t sent = 0;
	int result;

	if (READ_ONCE(ps->transport) == PVM_TRANSPORT_LOCAL)
		return pvm_local_sendmsg(&ps->local, message, total_length);
	if (!READ_ONCE(ps->connected))
		return ps->error ? -ps->error : -ENOTCONN;
	if (READ_ONCE(ps->sk.sk_shutdown) & SEND_SHUTDOWN)
		return -EPIPE;
	atomic_inc(&pvm_stream_senders);
	while (sent < total_length) {
		size_t chunk = min_t(size_t, total_length - sent,
				     PVM_SOCK_SLOT_SIZE);
		bool defer = !pvm_single_stream_sender();
		int slot;
		int error;

		if (defer) {
			slot = pvm_alloc_tx_slot_deferred(ps, nonblock, &notify);
		} else {
			/*
			 * Restore the original immediate-notify path exactly when no
			 * other sendmsg can amortize this exit.
			 */
			pvm_flush_notify(&notify);
			slot = pvm_alloc_tx_slot(ps, nonblock);
		}
		if (slot < 0) {
			result = sent ? sent : slot;
			goto out;
		}
		error = memcpy_from_msg(pvm_tx_slot(slot), message, chunk);
		if (error) {
			spin_lock_irq(&pvm_ring_lock);
			pvm_clear_tx_locked(slot, ps->capability,
					    ps->generation);
			spin_unlock_irq(&pvm_ring_lock);
			result = sent ? sent : error;
			goto out;
		}
		if (defer)
			error = pvm_submit_deferred(ps, PVM_CMD_TX, slot, 0,
						    chunk, nonblock, &notify);
		else
			error = pvm_submit(ps, PVM_CMD_TX, slot, 0, chunk,
					   nonblock);
		if (error) {
			spin_lock_irq(&pvm_ring_lock);
			pvm_clear_tx_locked(slot, ps->capability,
					    ps->generation);
			spin_unlock_irq(&pvm_ring_lock);
			result = sent ? sent : error;
			goto out;
		}
		sent += chunk;
	}
	result = sent;
out:
	pvm_flush_notify(&notify);
	atomic_dec(&pvm_stream_senders);
	return result;
}

static int pvm_datagram_sendmsg(struct socket *sock, struct msghdr *message,
				size_t total_length)
{
	struct pvm_sock *ps = pvm_sk(sock->sk);
	struct sockaddr_in *peer;
	struct pvm_sock_endpoint4 endpoint;
	bool nonblock = message->msg_flags & MSG_DONTWAIT;
	int slot;
	int error;

	if (message->msg_name) {
		if (message->msg_namelen < sizeof(*peer))
			return -EINVAL;
		peer = message->msg_name;
	} else {
		if (!ps->connected)
			return -EDESTADDRREQ;
		peer = &ps->peer;
	}
	if (peer->sin_family != AF_INET ||
	    ntohs(peer->sin_port) != PVM_DNS_PORT)
		return -EACCES;
	if (total_length < 12 || total_length > PVM_DNS_QUERY_MAX)
		return -EMSGSIZE;
	slot = pvm_alloc_tx_slot(ps, nonblock);
	if (slot < 0)
		return slot;
	endpoint.family = cpu_to_le16(AF_INET);
	endpoint.port = peer->sin_port;
	endpoint.address = peer->sin_addr.s_addr;
	memcpy(pvm_tx_slot(slot), &endpoint, sizeof(endpoint));
	error = memcpy_from_msg((u8 *)pvm_tx_slot(slot) + sizeof(endpoint),
				message, total_length);
	if (!error)
		error = pvm_submit(ps, PVM_CMD_DNS_QUERY, slot,
				   sizeof(endpoint), total_length, nonblock);
	if (error) {
		spin_lock_irq(&pvm_ring_lock);
		pvm_clear_tx_locked(slot, ps->capability, ps->generation);
		spin_unlock_irq(&pvm_ring_lock);
		return error;
	}
	return total_length;
}

static int pvm_first_rx(struct pvm_sock *ps)
{
	unsigned long flags;
	int slot = -1;

	spin_lock_irqsave(&pvm_ring_lock, flags);
	if (ps->rx_count)
		slot = ps->rx_queue[ps->rx_head];
	spin_unlock_irqrestore(&pvm_ring_lock, flags);
	return slot;
}

static int pvm_release_rx(struct pvm_sock *ps, unsigned int slot)
{
	long timeout = sock_sndtimeo(&ps->sk, false);
	bool notify = false;
	int error;

	for (;;) {
		spin_lock_irq(&pvm_ring_lock);
		if (!ps->rx_count || ps->rx_queue[ps->rx_head] != slot) {
			error = -EPROTO;
		} else {
			error = pvm_publish_locked(ps, PVM_CMD_RX_RELEASE,
						   slot, 0, 0, &notify);
		}
		if (!error) {
			/* Clear local ownership before the notify can trigger reuse. */
			pvm_rx_owner[slot] = NULL;
			pvm_rx_length[slot] = 0;
			pvm_rx_offset[slot] = 0;
			ps->rx_head = (ps->rx_head + 1) %
				      PVM_SOCK_CONNECTION_SLOTS;
			ps->rx_count--;
		}
		spin_unlock_irq(&pvm_ring_lock);
		if (error != -EAGAIN)
			break;
		error = pvm_wait_ring(&timeout);
		if (error)
			return error;
	}
	if (!error && notify)
		pvm_sock_notify();
	return error;
}

static int pvm_stream_recvmsg_locked(struct socket *sock,
				     struct msghdr *message,
				     size_t total_length, int flags)
{
	struct pvm_sock *ps = pvm_sk(sock->sk);
	bool nonblock = flags & MSG_DONTWAIT;
	long timeout = sock_rcvtimeo(sock->sk, nonblock);
	u32 available;
	u32 copied;
	int slot;
	long result;

	for (;;) {
		slot = pvm_first_rx(ps);
		if (slot >= 0)
			break;
		if (READ_ONCE(ps->error))
			return -ps->error;
		if (READ_ONCE(ps->peer_closed))
			return 0;
		if (!timeout)
			return -EAGAIN;
		result = wait_event_interruptible_timeout(
			*sk_sleep(sock->sk), pvm_first_rx(ps) >= 0 ||
			READ_ONCE(ps->error) || READ_ONCE(ps->peer_closed) ||
			pvm_protocol_fault, timeout);
		if (result < 0)
			return result;
		if (!result)
			return -EAGAIN;
		timeout = result;
	}
	spin_lock_irq(&pvm_ring_lock);
	if (pvm_rx_owner[slot] != ps) {
		spin_unlock_irq(&pvm_ring_lock);
		return -EPROTO;
	}
	available = pvm_rx_length[slot] - pvm_rx_offset[slot];
	copied = min_t(u32, available, total_length);
	spin_unlock_irq(&pvm_ring_lock);
	if (memcpy_to_msg(message,
			  (u8 *)pvm_rx_slot(slot) + pvm_rx_offset[slot], copied))
		return -EFAULT;
	if (flags & MSG_PEEK)
		return copied;
	spin_lock_irq(&pvm_ring_lock);
	pvm_rx_offset[slot] += copied;
	available = pvm_rx_length[slot] - pvm_rx_offset[slot];
	spin_unlock_irq(&pvm_ring_lock);
	if (!available) {
		result = pvm_release_rx(ps, slot);
		if (result)
			return result;
	}
	return copied;
}

static int pvm_stream_recvmsg(struct socket *sock, struct msghdr *message,
			      size_t total_length, int flags)
{
	struct pvm_sock *ps = pvm_sk(sock->sk);
	int result;

	if (READ_ONCE(ps->transport) == PVM_TRANSPORT_LOCAL)
		return pvm_local_recvmsg(&ps->local, message, total_length, flags);
	if (READ_ONCE(ps->transport) == PVM_TRANSPORT_NONE)
		return -ENOTCONN;
	lock_sock(sock->sk);
	result = pvm_stream_recvmsg_locked(sock, message, total_length, flags);
	release_sock(sock->sk);
	return result;
}

static int pvm_datagram_recvmsg_locked(struct socket *sock,
				       struct msghdr *message,
				       size_t total_length, int flags)
{
	struct pvm_sock *ps = pvm_sk(sock->sk);
	bool nonblock = flags & MSG_DONTWAIT;
	long timeout = sock_rcvtimeo(sock->sk, nonblock);
	struct pvm_sock_endpoint4 endpoint;
	struct sockaddr_in peer = { .sin_family = AF_INET };
	u32 available;
	u32 copied;
	int slot;
	long result;

	for (;;) {
		slot = pvm_first_rx(ps);
		if (slot >= 0)
			break;
		if (READ_ONCE(ps->error))
			return -ps->error;
		if (!timeout)
			return -EAGAIN;
		result = wait_event_interruptible_timeout(
			*sk_sleep(sock->sk), pvm_first_rx(ps) >= 0 ||
			READ_ONCE(ps->error) || pvm_protocol_fault, timeout);
		if (result < 0)
			return result;
		if (!result)
			return -EAGAIN;
		timeout = result;
	}
	spin_lock_irq(&pvm_ring_lock);
	if (pvm_rx_owner[slot] != ps) {
		spin_unlock_irq(&pvm_ring_lock);
		return -EPROTO;
	}
	available = pvm_rx_length[slot];
	copied = min_t(u32, available, total_length);
	memcpy(&endpoint, pvm_rx_slot(slot), sizeof(endpoint));
	spin_unlock_irq(&pvm_ring_lock);
	if (le16_to_cpu(endpoint.family) != AF_INET ||
	    be16_to_cpu(endpoint.port) != PVM_DNS_PORT) {
		pvm_release_rx(ps, slot);
		spin_lock_irq(&pvm_ring_lock);
		pvm_fail_all_locked(EPROTO);
		spin_unlock_irq(&pvm_ring_lock);
		return -EPROTO;
	}
	peer.sin_port = endpoint.port;
	peer.sin_addr.s_addr = endpoint.address;
	if (memcpy_to_msg(message,
			  (u8 *)pvm_rx_slot(slot) + sizeof(endpoint), copied))
		return -EFAULT;
	if (message->msg_name) {
		/* The socket core gives protocol recvmsg a sockaddr_storage. For
		 * recvfrom(2), msg_namelen starts at zero and is output-only. */
		memcpy(message->msg_name, &peer, sizeof(peer));
		message->msg_namelen = sizeof(peer);
	}
	if (copied < available)
		message->msg_flags |= MSG_TRUNC;
	if (!(flags & MSG_PEEK)) {
		result = pvm_release_rx(ps, slot);
		if (result)
			return result;
	}
	return flags & MSG_TRUNC ? available : copied;
}

static int pvm_datagram_recvmsg(struct socket *sock, struct msghdr *message,
				size_t total_length, int flags)
{
	int result;

	lock_sock(sock->sk);
	result = pvm_datagram_recvmsg_locked(sock, message, total_length, flags);
	release_sock(sock->sk);
	return result;
}

static __poll_t pvm_poll(struct file *file, struct socket *sock,
			 struct poll_table_struct *wait)
{
	struct pvm_sock *ps = pvm_sk(sock->sk);
	__poll_t mask = 0;

	if (READ_ONCE(ps->transport) == PVM_TRANSPORT_LOCAL) {
		mask = pvm_local_poll(&ps->local, file, sock, wait);
		if (READ_ONCE(ps->ingress_count))
			mask |= EPOLLIN | EPOLLRDNORM;
		return mask;
	}
	sock_poll_wait(file, sock, wait);
	poll_wait(file, &pvm_tx_wait, wait);
	poll_wait(file, &pvm_ring_wait, wait);
	if (pvm_first_rx(ps) >= 0)
		mask |= EPOLLIN | EPOLLRDNORM;
	if ((ps->datagram || READ_ONCE(ps->connected)) &&
	    !(READ_ONCE(ps->sk.sk_shutdown) & SEND_SHUTDOWN) &&
	    READ_ONCE(ps->tx_inflight) < PVM_SOCK_CONNECTION_SLOTS &&
	    find_first_zero_bit(pvm_tx_busy, PVM_SOCK_SLOT_COUNT) <
		PVM_SOCK_SLOT_COUNT && pvm_request_has_space())
		mask |= EPOLLOUT | EPOLLWRNORM;
	/* SOL_SOCKET/SO_ERROR consumes sk_err in the generic socket core. */
	if (READ_ONCE(ps->sk.sk_err))
		mask |= EPOLLERR;
	if (READ_ONCE(ps->peer_closed))
		mask |= EPOLLIN | EPOLLRDHUP | EPOLLHUP;
	return mask;
}

static int pvm_stream_shutdown(struct socket *sock, int how)
{
	struct pvm_sock *ps = pvm_sk(sock->sk);
	u8 shutdown = 0;
	int error;

	if (how < SHUT_RD || how > SHUT_RDWR)
		return -EINVAL;
	if (READ_ONCE(ps->transport) == PVM_TRANSPORT_LOCAL)
		return pvm_local_shutdown(&ps->local, how);
	if (READ_ONCE(ps->transport) != PVM_TRANSPORT_BROKER ||
	    !READ_ONCE(ps->connected))
		return -ENOTCONN;
	if (how != SHUT_WR)
		shutdown |= RCV_SHUTDOWN;
	if (how != SHUT_RD)
		shutdown |= SEND_SHUTDOWN;
	if ((READ_ONCE(ps->sk.sk_shutdown) & shutdown) == shutdown)
		return 0;
	error = pvm_submit(ps, PVM_CMD_SHUTDOWN, 0, 0, how, false);
	if (error)
		return error;
	/* The command is now ordered after every earlier TX descriptor. Mark the
	 * local syscall semantics immediately; the broker publishes its completion
	 * only after those TX slots drain and the host shutdown succeeds. */
	WRITE_ONCE(ps->sk.sk_shutdown,
		   READ_ONCE(ps->sk.sk_shutdown) | shutdown);
	if (shutdown & RCV_SHUTDOWN)
		ps->peer_closed = true;
	wake_up_interruptible(sk_sleep(&ps->sk));
	return 0;
}

static int pvm_getname(struct socket *sock, struct sockaddr *address, int peer)
{
	struct pvm_sock *ps = pvm_sk(sock->sk);
	struct sockaddr_in *result = (struct sockaddr_in *)address;

	if (READ_ONCE(ps->transport) == PVM_TRANSPORT_LOCAL)
		return pvm_local_getname(&ps->local, address, peer);
	memset(result, 0, sizeof(*result));
	result->sin_family = AF_INET;
	if (peer) {
		if (!ps->connected)
			return -ENOTCONN;
		*result = ps->peer;
	} else if (ps->bound.sin_family == AF_INET)
		*result = ps->bound;
	return sizeof(*result);
}

static int pvm_setsockopt(struct socket *sock, int level, int option,
			  sockptr_t value, unsigned int length)
{
	struct pvm_sock *ps = pvm_sk(sock->sk);
	int enabled;

	if (READ_ONCE(ps->transport) == PVM_TRANSPORT_LOCAL)
		return pvm_local_setsockopt(&ps->local, level, option, value,
					    length);
	if (length < sizeof(enabled) || copy_from_sockptr(&enabled, value,
							 sizeof(enabled)))
		return -EFAULT;
	if (!ps->datagram && level == IPPROTO_TCP && option == TCP_NODELAY) {
		ps->tcp_nodelay = enabled != 0;
		return 0;
	}
	if (!ps->datagram && level == SOL_SOCKET && option == SO_KEEPALIVE)
		return 0;
	/* glibc enables IP_RECVERR before DNS sendto(2). Broker failures already
	 * arrive through completion events, so no host error queue is exposed. */
	if (ps->datagram && level == SOL_IP && option == IP_RECVERR)
		return 0;
	return -ENOPROTOOPT;
}

static int pvm_protocol_getsockopt(struct socket *sock, int level, int option,
			  char __user *value, int __user *length)
{
	struct pvm_sock *ps = pvm_sk(sock->sk);

	if (READ_ONCE(ps->transport) == PVM_TRANSPORT_LOCAL)
		return pvm_local_getsockopt(&ps->local, level, option, value,
					    length);
	/* SOL_SOCKET options, including SO_ERROR, bypass proto_ops here and are
	 * served from struct sock by the generic socket core. */
	(void)sock;
	(void)level;
	(void)option;
	(void)value;
	(void)length;
	return -ENOPROTOOPT;
}

static int pvm_release(struct socket *sock)
{
	struct sock *sk = sock->sk;
	struct pvm_sock *ps;
	int close_error = 0;
	int slot;

	if (!sk)
		return 0;
	ps = pvm_sk(sk);
	if (ps->listening || !list_empty(&ps->listener_node) ||
	    ps->ingress_count)
		pvm_unregister_listener(ps);
	if (ps->transport == PVM_TRANSPORT_LOCAL)
		pvm_local_release(&ps->local);
	while ((slot = pvm_first_rx(ps)) >= 0)
		if (pvm_release_rx(ps, slot))
			break;
	if (ps->capability_allocated && ps->broker_opened) {
		spin_lock_irq(&pvm_ring_lock);
		pvm_capability_closing[ps->capability] = ps->generation;
		spin_unlock_irq(&pvm_ring_lock);
		close_error = pvm_submit(ps, PVM_CMD_CLOSE, 0, 0, 0, false);
	}
	if (ps->capability_allocated) {
		spin_lock_irq(&pvm_ring_lock);
		if (pvm_capability_socket[ps->capability] == ps)
			pvm_capability_socket[ps->capability] = NULL;
		if (!ps->broker_opened) {
			pvm_capability_closing[ps->capability] = ps->generation;
			pvm_finish_capability_close_locked(ps->capability,
							   ps->generation);
		} else if (close_error) {
			/* Reuse would alias a host capability whose CLOSE was never queued. */
			pvm_capability_closing[ps->capability] = 0;
			pvm_fail_all_locked(EPROTO);
		}
		spin_unlock_irq(&pvm_ring_lock);
	}
	sock_orphan(sk);
	sock->sk = NULL;
	sock_put(sk);
	return close_error;
}

static struct proto pvm_stream_proto = {
	.name = "PVM_STREAM",
	.owner = THIS_MODULE,
	.obj_size = sizeof(struct pvm_sock),
};

static struct proto pvm_datagram_proto = {
	.name = "PVM_DNS_DGRAM",
	.owner = THIS_MODULE,
	.obj_size = sizeof(struct pvm_sock),
};

static const struct proto_ops pvm_stream_ops = {
	.family = PF_INET,
	.owner = THIS_MODULE,
	.release = pvm_release,
	.bind = pvm_stream_bind,
	.connect = pvm_stream_connect,
	.socketpair = sock_no_socketpair,
	.accept = pvm_stream_accept,
	.getname = pvm_getname,
	.poll = pvm_poll,
	.ioctl = sock_no_ioctl,
	.listen = pvm_stream_listen,
	.shutdown = pvm_stream_shutdown,
	.setsockopt = pvm_setsockopt,
	.getsockopt = pvm_protocol_getsockopt,
	.sendmsg = pvm_stream_sendmsg,
	.recvmsg = pvm_stream_recvmsg,
	.mmap = sock_no_mmap,
};

static const struct proto_ops pvm_datagram_ops = {
	.family = PF_INET,
	.owner = THIS_MODULE,
	.release = pvm_release,
	.bind = pvm_datagram_bind,
	.connect = pvm_datagram_connect,
	.socketpair = sock_no_socketpair,
	.accept = sock_no_accept,
	.getname = pvm_getname,
	.poll = pvm_poll,
	.ioctl = sock_no_ioctl,
	.listen = sock_no_listen,
	.shutdown = sock_no_shutdown,
	.setsockopt = pvm_setsockopt,
	.getsockopt = pvm_protocol_getsockopt,
	.sendmsg = pvm_datagram_sendmsg,
	.recvmsg = pvm_datagram_recvmsg,
	.mmap = sock_no_mmap,
};

static int pvm_create(struct net *net, struct socket *sock, int protocol,
			      int kern)
{
	bool datagram;

	if (!net_eq(net, &init_net))
		return -EAFNOSUPPORT;
	if (sock->type == SOCK_STREAM && (!protocol || protocol == IPPROTO_TCP)) {
		datagram = false;
	} else if (sock->type == SOCK_DGRAM &&
		   (!protocol || protocol == IPPROTO_UDP)) {
		datagram = true;
	} else if (sock->type != SOCK_STREAM && sock->type != SOCK_DGRAM) {
		return -ESOCKTNOSUPPORT;
	} else {
		return -EPROTONOSUPPORT;
	}
	return pvm_init_outer_socket(net, sock, datagram, kern);
}

static const struct net_proto_family pvm_family = {
	.family = PF_INET,
	.create = pvm_create,
	.owner = THIS_MODULE,
};

static int __init pvm_socket_init(void)
{
	unsigned int index;
	int error;

	static_assert(sizeof(struct pvm_sock_desc) == 32);
	static_assert(sizeof(struct pvm_sock_event) == 32);
	static_assert(sizeof(struct pvm_sock_endpoint4) == 8);
	pvm_g2h = memremap(PVM_SOCK_G2H_GPA, PVM_SOCK_REGION_SIZE,
			   MEMREMAP_WB);
	pvm_h2g = memremap(PVM_SOCK_H2G_GPA, PVM_SOCK_REGION_SIZE,
			   MEMREMAP_WB);
	if (!pvm_g2h || !pvm_h2g) {
		error = -ENOMEM;
		goto unmap;
	}
	if (memcmp((u8 *)pvm_h2g + PVM_H2G_MAGIC, "PVMSOCK\0", 8) ||
	    le16_to_cpu(*(__le16 *)((u8 *)pvm_h2g + PVM_H2G_VERSION)) !=
		PVM_SOCK_ABI_VERSION ||
	    (le64_to_cpu(*(__le64 *)((u8 *)pvm_h2g + PVM_H2G_FEATURES)) &
	     (PVM_SOCK_FEATURE_TCP | PVM_SOCK_FEATURE_DNS_UDP |
	      PVM_SOCK_FEATURE_INGRESS)) !=
		(PVM_SOCK_FEATURE_TCP | PVM_SOCK_FEATURE_DNS_UDP |
		 PVM_SOCK_FEATURE_INGRESS)) {
		error = -EPROTO;
		goto unmap;
	}
	/* Request the first host event, but suppress request-credit IRQs until a
	 * producer actually blocks on a full command ring. */
	smp_store_release(pvm_g2h_word(PVM_G2H_RESPONSE_EVENT), 0);
	smp_store_release(pvm_g2h_word(PVM_G2H_REQUEST_CREDIT_EVENT), ~0U);
	for (index = 0; index < PVM_SOCK_CAPABILITIES; index++)
		pvm_capability_generation[index] = 1;
	error = proto_register(&pvm_stream_proto, 0);
	if (error)
		goto unmap;
	error = proto_register(&pvm_datagram_proto, 0);
	if (error)
		goto stream_proto;
	error = sock_register(&pvm_family);
	if (error)
		goto datagram_proto;
	error = request_irq(PVM_SOCK_IRQ, pvm_socket_irq, 0, "pvm_socket",
			    &pvm_irq_cookie);
	if (error)
		goto family;
	pr_info("PVM PF_INET TCP + restricted UDP DNS provider active\n");
	return 0;

family:
	sock_unregister(PF_INET);
datagram_proto:
	proto_unregister(&pvm_datagram_proto);
stream_proto:
	proto_unregister(&pvm_stream_proto);
unmap:
	if (pvm_h2g)
		memunmap(pvm_h2g);
	if (pvm_g2h)
		memunmap(pvm_g2h);
	return error;
}
subsys_initcall(pvm_socket_init);

MODULE_DESCRIPTION("PVM host-backed PF_INET TCP and restricted UDP DNS provider");
MODULE_LICENSE("GPL");
