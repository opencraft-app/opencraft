/* SPDX-License-Identifier: GPL-2.0-only */
#ifndef _PVM_SOCKET_LOCAL_H
#define _PVM_SOCKET_LOCAL_H

#include <linux/poll.h>
#include <linux/socket.h>

struct file;
struct msghdr;
struct net;
struct poll_table_struct;
struct sock;
struct socket;

struct pvm_local_socket {
	struct socket *inner;
	struct sock *outer;
	void (*state_change)(struct sock *sk);
	void (*data_ready)(struct sock *sk);
	void (*write_space)(struct sock *sk);
	void (*error_report)(struct sock *sk);
};

int pvm_local_open(struct pvm_local_socket *local, struct net *net,
		   int type, int protocol, struct sock *outer,
		   bool tcp_nodelay);
void pvm_local_adopt(struct pvm_local_socket *local, struct socket *inner,
		     struct sock *outer);
void pvm_local_release(struct pvm_local_socket *local);
int pvm_local_bind(struct pvm_local_socket *local, struct sockaddr *address,
		   int address_length);
int pvm_local_connect(struct pvm_local_socket *local,
		      struct sockaddr *address, int address_length, int flags);
int pvm_local_listen(struct pvm_local_socket *local, int backlog);
int pvm_local_accept(struct pvm_local_socket *local,
		     struct pvm_local_socket *accepted, int flags);
bool pvm_local_accept_ready(struct pvm_local_socket *local);
int pvm_local_getname(struct pvm_local_socket *local,
		      struct sockaddr *address, int peer);
__poll_t pvm_local_poll(struct pvm_local_socket *local, struct file *file,
			struct socket *outer, struct poll_table_struct *wait);
int pvm_local_shutdown(struct pvm_local_socket *local, int how);
int pvm_local_setsockopt(struct pvm_local_socket *local, int level, int option,
			 sockptr_t value, unsigned int length);
int pvm_local_getsockopt(struct pvm_local_socket *local, int level, int option,
			 char __user *value, int __user *length);
int pvm_local_sendmsg(struct pvm_local_socket *local, struct msghdr *message,
		      size_t total_length);
int pvm_local_recvmsg(struct pvm_local_socket *local, struct msghdr *message,
		      size_t total_length, int flags);

#endif
