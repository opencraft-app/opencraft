// SPDX-License-Identifier: GPL-2.0-only

#include <linux/errno.h>
#include <linux/if.h>
#include <linux/in.h>
#include <linux/net.h>
#include <linux/netdevice.h>
#include <linux/poll.h>
#include <linux/rtnetlink.h>
#include <linux/socket.h>
#include <linux/tcp.h>
#include <net/inet_common.h>
#include <net/net_namespace.h>
#include <net/sock.h>

#include "pvm_socket_local.h"

static struct pvm_local_socket *pvm_local_context(struct sock *inner)
{
	return rcu_dereference_sk_user_data(inner);
}

static void pvm_local_state_change(struct sock *inner)
{
	struct pvm_local_socket *local;

	rcu_read_lock();
	local = pvm_local_context(inner);
	if (local) {
		local->state_change(inner);
		wake_up_interruptible_poll(sk_sleep(local->outer),
					   EPOLLIN | EPOLLOUT | EPOLLRDHUP |
					   EPOLLHUP);
	}
	rcu_read_unlock();
}

static void pvm_local_data_ready(struct sock *inner)
{
	struct pvm_local_socket *local;

	rcu_read_lock();
	local = pvm_local_context(inner);
	if (local) {
		local->data_ready(inner);
		wake_up_interruptible_poll(sk_sleep(local->outer),
					   EPOLLIN | EPOLLRDNORM);
	}
	rcu_read_unlock();
}

static void pvm_local_write_space(struct sock *inner)
{
	struct pvm_local_socket *local;

	rcu_read_lock();
	local = pvm_local_context(inner);
	if (local) {
		local->write_space(inner);
		wake_up_interruptible_poll(sk_sleep(local->outer),
					   EPOLLOUT | EPOLLWRNORM);
	}
	rcu_read_unlock();
}

static void pvm_local_error_report(struct sock *inner)
{
	struct pvm_local_socket *local;
	int error;

	rcu_read_lock();
	local = pvm_local_context(inner);
	if (local) {
		/* SO_ERROR is queried through the stable PVM facade, not the hidden
		 * socket.  Move the one-shot error there as soon as TCP reports it so
		 * userspace does not have to call poll() before getsockopt().
		 */
		error = sock_error(inner);
		if (error && !READ_ONCE(local->outer->sk_err))
			WRITE_ONCE(local->outer->sk_err, -error);
		local->error_report(inner);
		wake_up_interruptible_poll(sk_sleep(local->outer), EPOLLERR);
	}
	rcu_read_unlock();
}

static void pvm_local_attach_callbacks(struct pvm_local_socket *local,
				       struct sock *outer)
{
	struct sock *inner = local->inner->sk;

	write_lock_bh(&inner->sk_callback_lock);
	local->outer = outer;
	local->state_change = inner->sk_state_change;
	local->data_ready = inner->sk_data_ready;
	local->write_space = inner->sk_write_space;
	local->error_report = inner->sk_error_report;
	__rcu_assign_sk_user_data_with_flags(inner, local, SK_USER_DATA_NOCOPY);
	inner->sk_state_change = pvm_local_state_change;
	inner->sk_data_ready = pvm_local_data_ready;
	inner->sk_write_space = pvm_local_write_space;
	inner->sk_error_report = pvm_local_error_report;
	write_unlock_bh(&inner->sk_callback_lock);
}

static void pvm_local_detach_callbacks(struct pvm_local_socket *local)
{
	struct sock *inner = local->inner->sk;

	write_lock_bh(&inner->sk_callback_lock);
	inner->sk_state_change = local->state_change;
	inner->sk_data_ready = local->data_ready;
	inner->sk_write_space = local->write_space;
	inner->sk_error_report = local->error_report;
	rcu_assign_sk_user_data(inner, NULL);
	write_unlock_bh(&inner->sk_callback_lock);
	synchronize_rcu();
	local->outer = NULL;
}

static int pvm_local_enable_loopback(struct net *net)
{
	struct net_device *loopback;
	int error = 0;

	if (!net_eq(net, &init_net))
		return -EAFNOSUPPORT;
	loopback = READ_ONCE(net->loopback_dev);
	if (loopback && (READ_ONCE(loopback->flags) & IFF_UP))
		return 0;
	rtnl_lock();
	loopback = __dev_get_by_name(net, "lo");
	if (!loopback)
		error = -ENODEV;
	else if (!(loopback->flags & IFF_UP))
		error = dev_change_flags(loopback,
					 dev_get_flags(loopback) | IFF_UP, NULL);
	rtnl_unlock();
	return error;
}

static int pvm_local_set_int(struct socket *socket, int level, int option,
			     int value)
{
	if (level == SOL_SOCKET)
		return sock_setsockopt(socket, level, option,
				       KERNEL_SOCKPTR(&value), sizeof(value));
	return READ_ONCE(socket->ops)->setsockopt(socket, level, option,
					 KERNEL_SOCKPTR(&value), sizeof(value));
}

static int pvm_local_copy_options(struct socket *inner, struct sock *outer,
				  bool tcp_nodelay)
{
	int error;

	error = pvm_local_set_int(inner, SOL_SOCKET, SO_REUSEADDR,
				  outer->sk_reuse != SK_NO_REUSE);
	if (error)
		return error;
	if (outer->sk_reuseport) {
		error = pvm_local_set_int(inner, SOL_SOCKET, SO_REUSEPORT, 1);
		if (error)
			return error;
	}
	if (sock_flag(outer, SOCK_KEEPOPEN)) {
		error = pvm_local_set_int(inner, SOL_SOCKET, SO_KEEPALIVE, 1);
		if (error)
			return error;
	}
	if (tcp_nodelay) {
		error = pvm_local_set_int(inner, IPPROTO_TCP, TCP_NODELAY, 1);
		if (error)
			return error;
	}
	WRITE_ONCE(inner->sk->sk_sndtimeo, READ_ONCE(outer->sk_sndtimeo));
	WRITE_ONCE(inner->sk->sk_rcvtimeo, READ_ONCE(outer->sk_rcvtimeo));
	return 0;
}

int pvm_local_open(struct pvm_local_socket *local, struct net *net,
		   int type, int protocol, struct sock *outer,
		   bool tcp_nodelay)
{
	struct socket *inner;
	int error;

	if (local->inner)
		return 0;
	error = pvm_local_enable_loopback(net);
	if (error)
		return error;
	error = inet_create_kern_socket(net, type, protocol, &inner);
	if (error)
		return error;
	error = pvm_local_copy_options(inner, outer, tcp_nodelay);
	if (error) {
		sock_release(inner);
		return error;
	}
	local->inner = inner;
	pvm_local_attach_callbacks(local, outer);
	return 0;
}

void pvm_local_adopt(struct pvm_local_socket *local, struct socket *inner,
		     struct sock *outer)
{
	local->inner = inner;
	pvm_local_attach_callbacks(local, outer);
}

void pvm_local_release(struct pvm_local_socket *local)
{
	struct socket *inner = local->inner;

	if (inner) {
		pvm_local_detach_callbacks(local);
		local->inner = NULL;
		sock_release(inner);
	}
}

int pvm_local_bind(struct pvm_local_socket *local, struct sockaddr *address,
		   int address_length)
{
	return kernel_bind(local->inner, address, address_length);
}

int pvm_local_connect(struct pvm_local_socket *local,
		      struct sockaddr *address, int address_length, int flags)
{
	return kernel_connect(local->inner, address, address_length, flags);
}

int pvm_local_listen(struct pvm_local_socket *local, int backlog)
{
	return kernel_listen(local->inner, backlog);
}

int pvm_local_accept(struct pvm_local_socket *local,
		     struct pvm_local_socket *accepted, int flags)
{
	struct socket *inner;
	int error;

	error = kernel_accept(local->inner, &inner, flags);
	if (!error) {
		/* TCP clones the listener callbacks into the accepted sock. Restore
		 * the native callbacks before the child gets its own facade bridge;
		 * otherwise the bridge would save and recursively call itself.
		 */
		write_lock_bh(&inner->sk->sk_callback_lock);
		inner->sk->sk_state_change = local->state_change;
		inner->sk->sk_data_ready = local->data_ready;
		inner->sk->sk_write_space = local->write_space;
		inner->sk->sk_error_report = local->error_report;
		rcu_assign_sk_user_data(inner->sk, NULL);
		write_unlock_bh(&inner->sk->sk_callback_lock);
		accepted->inner = inner;
	}
	return error;
}

bool pvm_local_accept_ready(struct pvm_local_socket *local)
{
	__poll_t mask;

	mask = READ_ONCE(local->inner->ops)->poll(NULL, local->inner, NULL);
	return mask & (EPOLLIN | EPOLLRDNORM | EPOLLERR | EPOLLHUP);
}

int pvm_local_getname(struct pvm_local_socket *local,
		      struct sockaddr *address, int peer)
{
	return READ_ONCE(local->inner->ops)->getname(local->inner, address, peer);
}

__poll_t pvm_local_poll(struct pvm_local_socket *local, struct file *file,
			struct socket *outer, struct poll_table_struct *wait)
{
	__poll_t mask;
	int error;

	/* The callback bridge mirrors native readiness onto this stable facade
	 * waitqueue, including when epoll registered before transport selection.
	 */
	sock_poll_wait(file, outer, wait);
	mask = READ_ONCE(local->inner->ops)->poll(file, local->inner, NULL);
	if (mask & EPOLLERR) {
		error = sock_error(local->inner->sk);
		if (error && !READ_ONCE(outer->sk->sk_err))
			WRITE_ONCE(outer->sk->sk_err, -error);
		mask &= ~EPOLLERR;
	}
	if (READ_ONCE(outer->sk->sk_err))
		mask |= EPOLLERR;
	return mask;
}

int pvm_local_shutdown(struct pvm_local_socket *local, int how)
{
	return kernel_sock_shutdown(local->inner, how);
}

int pvm_local_setsockopt(struct pvm_local_socket *local, int level, int option,
			 sockptr_t value, unsigned int length)
{
	return READ_ONCE(local->inner->ops)->setsockopt(local->inner, level,
						       option, value, length);
}

int pvm_local_getsockopt(struct pvm_local_socket *local, int level, int option,
			 char __user *value, int __user *length)
{
	return READ_ONCE(local->inner->ops)->getsockopt(local->inner, level,
						       option, value, length);
}

int pvm_local_sendmsg(struct pvm_local_socket *local, struct msghdr *message,
		      size_t total_length)
{
	return READ_ONCE(local->inner->ops)->sendmsg(local->inner, message,
						    total_length);
}

int pvm_local_recvmsg(struct pvm_local_socket *local, struct msghdr *message,
		      size_t total_length, int flags)
{
	return READ_ONCE(local->inner->ops)->recvmsg(local->inner, message,
						    total_length, flags);
}
