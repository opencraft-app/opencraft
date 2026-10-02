/* SPDX-License-Identifier: MIT OR Apache-2.0 */

#define _GNU_SOURCE

#include <errno.h>
#include <arpa/inet.h>
#include <fcntl.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/eventfd.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/mount.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>
#include <netinet/tcp.h>

#define PVM_STREAM_FIFO_BYTES (6U * 4096U + 733U)
#define PVM_CLOSE_DRAIN_BYTES (4U * 4096U - 19U)
#define PVM_HOST_LOOPBACK_ALIAS 0xc0000201U

static void fail(const char *operation) {
  dprintf(STDERR_FILENO, "MINISANDBOX_PVM_LINUX_FAIL %s: %s\n", operation,
          strerror(errno));
  exit(1);
}

static void handle_signal(int signal_number) { (void)signal_number; }

static void check_process_and_pipe(void) {
  int pipe_descriptors[2];
  if (pipe(pipe_descriptors) != 0)
    fail("pipe");
  pid_t child = fork();
  if (child < 0)
    fail("fork");
  if (child == 0) {
    const char payload[] = "fork-pipe";
    if (write(pipe_descriptors[1], payload, sizeof(payload)) !=
        (ssize_t)sizeof(payload))
      _exit(2);
    _exit(23);
  }
  close(pipe_descriptors[1]);
  char payload[16] = {0};
  if (read(pipe_descriptors[0], payload, sizeof(payload)) <= 0)
    fail("pipe read");
  close(pipe_descriptors[0]);
  int status = 0;
  if (waitpid(child, &status, 0) != child || !WIFEXITED(status) ||
      WEXITSTATUS(status) != 23)
    fail("waitpid");
}

static void check_exec(void) {
  pid_t child = fork();
  if (child < 0)
    fail("exec fork");
  if (child == 0) {
    char *const arguments[] = {(char *)"/init", (char *)"--exec-child", NULL};
    char *const environment[] = {NULL};
    execve("/init", arguments, environment);
    _exit(127);
  }
  int status = 0;
  if (waitpid(child, &status, 0) != child || !WIFEXITED(status) ||
      WEXITSTATUS(status) != 0)
    fail("execve");
}

static void check_epoll(void) {
  int event = eventfd(0, EFD_CLOEXEC);
  if (event < 0)
    fail("eventfd");
  int poller = epoll_create1(EPOLL_CLOEXEC);
  if (poller < 0)
    fail("epoll_create1");
  struct epoll_event registration = {.events = EPOLLIN, .data.fd = event};
  if (epoll_ctl(poller, EPOLL_CTL_ADD, event, &registration) != 0)
    fail("epoll_ctl");
  uint64_t value = 1;
  if (write(event, &value, sizeof(value)) != (ssize_t)sizeof(value))
    fail("eventfd write");
  struct epoll_event result = {0};
  if (epoll_wait(poller, &result, 1, 0) != 1 || result.data.fd != event)
    fail("epoll_wait");
  close(poller);
  close(event);
}

static void wait_epoll_mask(int poller, int descriptor, uint32_t mask,
                            const char *operation) {
  struct epoll_event event = {0};

  for (;;) {
    int ready = epoll_wait(poller, &event, 1, -1);

    if (ready < 0 && errno == EINTR)
      continue;
    if (ready != 1 || event.data.fd != descriptor) {
      errno = EPROTO;
      fail(operation);
    }
    if (event.events & mask)
      return;
  }
}

static void check_local_loopback(void) {
  static const char request[] = "local-request";
  static const char response[] = "local-response";
  struct sockaddr_in address = {
      .sin_family = AF_INET,
      .sin_addr.s_addr = htonl(INADDR_LOOPBACK),
  };
  socklen_t address_length = sizeof(address);
  int enabled = 1;
  int listener = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, IPPROTO_TCP);
  int listener_poller;
  pid_t child;

  dprintf(STDOUT_FILENO, "MINISANDBOX_PVM_LOCAL_TCP_START\n");
  if (listener < 0)
    fail("local loopback listener socket");
  if (setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &enabled,
                 sizeof(enabled)) != 0)
    fail("local loopback SO_REUSEADDR");
  if (bind(listener, (struct sockaddr *)&address, sizeof(address)) != 0)
    fail("local loopback bind");
  if (listen(listener, 4) != 0)
    fail("local loopback listen");
  if (getsockname(listener, (struct sockaddr *)&address, &address_length) != 0 ||
      address_length != sizeof(address) || !address.sin_port)
    fail("local loopback getsockname");
  dprintf(STDOUT_FILENO, "MINISANDBOX_PVM_LOCAL_TCP_LISTENING port=%u\n",
          (unsigned)ntohs(address.sin_port));
  listener_poller = epoll_create1(EPOLL_CLOEXEC);
  if (listener_poller < 0)
    fail("local listener epoll_create1");
  struct epoll_event listener_registration = {
      .events = EPOLLIN | EPOLLET,
      .data.fd = listener,
  };
  if (epoll_ctl(listener_poller, EPOLL_CTL_ADD, listener,
                &listener_registration) != 0)
    fail("local listener epoll_ctl");

  child = fork();
  if (child < 0)
    fail("local loopback fork");
  if (child == 0) {
    char received[sizeof(request)] = {0};
    int accepted;

    wait_epoll_mask(listener_poller, listener, EPOLLIN,
                    "local listener epoll_wait");
    accepted = accept4(listener, NULL, NULL, SOCK_CLOEXEC);
    if (accepted < 0)
      _exit(30);
    if (recv(accepted, received, sizeof(received), MSG_WAITALL) !=
            (ssize_t)sizeof(received) ||
        memcmp(received, request, sizeof(request)) != 0)
      _exit(31);
    if (send(accepted, response, sizeof(response), 0) !=
        (ssize_t)sizeof(response))
      _exit(32);
    if (shutdown(accepted, SHUT_WR) != 0)
      _exit(33);
    close(accepted);
    close(listener_poller);
    close(listener);
    _exit(0);
  }

  {
    struct sockaddr_in peer = {0};
    socklen_t peer_length = sizeof(peer);
    char received[sizeof(response)] = {0};
    int socket_error = 0;
    socklen_t socket_error_length = sizeof(socket_error);
    int stream = socket(AF_INET,
                        SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK,
                        IPPROTO_TCP);
    int poller = epoll_create1(EPOLL_CLOEXEC);
    struct epoll_event registration = {
        .events = EPOLLIN | EPOLLOUT | EPOLLERR | EPOLLRDHUP | EPOLLET,
        .data.fd = stream,
    };
    ssize_t progress;

    if (stream < 0 || poller < 0)
      fail("local client setup");
    /* Register before connect: selecting the hidden INET backend must migrate
       readiness without invalidating this stable PVM socket facade. */
    if (epoll_ctl(poller, EPOLL_CTL_ADD, stream, &registration) != 0)
      fail("local client epoll_ctl");
    if (setsockopt(stream, IPPROTO_TCP, TCP_NODELAY, &enabled,
                   sizeof(enabled)) != 0)
      fail("local client TCP_NODELAY");
    if (connect(stream, (struct sockaddr *)&address, sizeof(address)) != 0 &&
        errno != EINPROGRESS)
      fail("local client connect");
    dprintf(STDOUT_FILENO, "MINISANDBOX_PVM_LOCAL_TCP_CONNECTING\n");
    wait_epoll_mask(poller, stream, EPOLLOUT | EPOLLERR,
                    "local client connect wait");
    if (getsockopt(stream, SOL_SOCKET, SO_ERROR, &socket_error,
                   &socket_error_length) != 0 || socket_error) {
      errno = socket_error ? socket_error : EPROTO;
      fail("local client SO_ERROR");
    }
    if (getpeername(stream, (struct sockaddr *)&peer, &peer_length) != 0 ||
        peer_length != sizeof(peer) || peer.sin_family != AF_INET ||
        peer.sin_addr.s_addr != htonl(INADDR_LOOPBACK) ||
        peer.sin_port != address.sin_port)
      fail("local client getpeername");
    if (send(stream, request, sizeof(request), 0) != (ssize_t)sizeof(request))
      fail("local client send");
    for (;;) {
      progress = recv(stream, received, sizeof(received), MSG_DONTWAIT);
      if (progress == (ssize_t)sizeof(received))
        break;
      if (progress < 0 && errno == EAGAIN) {
        wait_epoll_mask(poller, stream,
                        EPOLLIN | EPOLLERR | EPOLLHUP | EPOLLRDHUP,
                        "local client receive wait");
        continue;
      }
      errno = EPROTO;
      fail("local client receive");
    }
    if (memcmp(received, response, sizeof(response)) != 0)
      fail("local client response");
    close(poller);
    close(stream);
  }
  close(listener_poller);
  close(listener);
  {
    int status = 0;

    if (waitpid(child, &status, 0) != child || !WIFEXITED(status) ||
        WEXITSTATUS(status) != 0) {
      errno = EPROTO;
      fail("local loopback child");
    }
  }
  dprintf(STDOUT_FILENO, "MINISANDBOX_PVM_LOCAL_TCP_OK\n");
}

static int prepare_local_checkpoint_listener(struct sockaddr_in *address) {
  socklen_t address_length = sizeof(*address);
  int listener = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, IPPROTO_TCP);

  *address = (struct sockaddr_in){
      .sin_family = AF_INET,
      .sin_addr.s_addr = htonl(INADDR_LOOPBACK),
  };
  if (listener < 0)
    fail("local checkpoint listener socket");
  if (bind(listener, (struct sockaddr *)address, sizeof(*address)) != 0)
    fail("local checkpoint listener bind");
  if (listen(listener, 1) != 0)
    fail("local checkpoint listener listen");
  if (getsockname(listener, (struct sockaddr *)address, &address_length) != 0 ||
      address_length != sizeof(*address) || !address->sin_port)
    fail("local checkpoint listener getsockname");
  dprintf(STDOUT_FILENO,
          "MINISANDBOX_PVM_LOCAL_TCP_WARM_READY port=%u\n",
          (unsigned)ntohs(address->sin_port));
  return listener;
}

static void check_local_checkpoint_listener(int listener,
                                            const struct sockaddr_in *address) {
  static const char request[] = "checkpoint-loopback";
  char received[sizeof(request)] = {0};
  int stream = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, IPPROTO_TCP);
  int accepted;

  if (stream < 0)
    fail("local resumed client socket");
  if (connect(stream, (const struct sockaddr *)address, sizeof(*address)) != 0)
    fail("local resumed client connect");
  accepted = accept4(listener, NULL, NULL, SOCK_CLOEXEC);
  if (accepted < 0)
    fail("local resumed accept");
  if (send(stream, request, sizeof(request), 0) != (ssize_t)sizeof(request))
    fail("local resumed send");
  if (recv(accepted, received, sizeof(received), MSG_WAITALL) !=
          (ssize_t)sizeof(received) ||
      memcmp(received, request, sizeof(request)) != 0) {
    errno = EPROTO;
    fail("local resumed receive");
  }
  close(accepted);
  close(stream);
  close(listener);
  dprintf(STDOUT_FILENO, "MINISANDBOX_PVM_LOCAL_TCP_RESUMED_OK\n");
}

static void check_memory_signal_and_futex(void) {
  void *page = mmap(NULL, 4096, PROT_READ | PROT_WRITE,
                    MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (page == MAP_FAILED)
    fail("mmap");
  memset(page, 0x5a, 4096);
  if (mprotect(page, 4096, PROT_READ) != 0)
    fail("mprotect");
  if (munmap(page, 4096) != 0)
    fail("munmap");

  struct sigaction action = {.sa_handler = handle_signal};
  sigemptyset(&action.sa_mask);
  if (sigaction(SIGUSR1, &action, NULL) != 0 || raise(SIGUSR1) != 0)
    fail("signal");
  if (kill(getpid(), 0) != 0)
    fail("kill");

  _Atomic int futex_word = 0;
  if (syscall(SYS_futex, &futex_word, 129 /* FUTEX_WAKE_PRIVATE */, 1, NULL,
              NULL, 0) < 0)
    fail("futex");
}

static uint16_t read_be16(const unsigned char *bytes) {
  return ((uint16_t)bytes[0] << 8) | bytes[1];
}

static void write_be16(unsigned char *bytes, uint16_t value) {
  bytes[0] = (unsigned char)(value >> 8);
  bytes[1] = (unsigned char)value;
}

static void write_be24(unsigned char *bytes, size_t value) {
  bytes[0] = (unsigned char)(value >> 16);
  bytes[1] = (unsigned char)(value >> 8);
  bytes[2] = (unsigned char)value;
}

static int command_line_value(const char *command_line, const char *key,
                              char *value, size_t capacity) {
  const char *start = strstr(command_line, key);
  size_t length;

  if (!start)
    return 0;
  start += strlen(key);
  length = strcspn(start, " \n");
  if (!length || length >= capacity)
    fail("PVM command line option");
  memcpy(value, start, length);
  value[length] = '\0';
  return 1;
}

static void read_kernel_command_line(char *command_line, size_t capacity) {
  ssize_t length;
  int command;

  if (mkdir("/proc", 0555) != 0 && errno != EEXIST)
    fail("mkdir /proc");
  if (mount("proc", "/proc", "proc", 0, NULL) != 0 && errno != EBUSY)
    fail("mount proc");
  command = open("/proc/cmdline", O_RDONLY | O_CLOEXEC);
  if (command < 0)
    fail("open /proc/cmdline");
  length = read(command, command_line, capacity - 1);
  close(command);
  if (length < 0)
    fail("read /proc/cmdline");
  command_line[length] = '\0';
}

static int prepare_host_ingress_listener_if_requested(
    const char *command_line, const char *option_name, int *poller) {
  char port_text[6] = {0};
  struct sockaddr_in address = {
      .sin_family = AF_INET,
      .sin_addr.s_addr = htonl(INADDR_LOOPBACK),
  };
  struct epoll_event registration = {
      .events = EPOLLIN | EPOLLET,
  };
  unsigned long port;
  int listener;

  *poller = -1;
  if (!command_line_value(command_line, option_name, port_text,
                          sizeof(port_text)))
    return -1;
  port = strtoul(port_text, NULL, 10);
  if (!port || port > UINT16_MAX) {
    errno = EINVAL;
    fail("host ingress port");
  }
  address.sin_port = htons((uint16_t)port);
  listener = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK,
                    IPPROTO_TCP);
  if (listener < 0)
    fail("host ingress listener socket");
  if (bind(listener, (struct sockaddr *)&address, sizeof(address)) != 0)
    fail("host ingress listener bind");
  if (listen(listener, 16) != 0)
    fail("host ingress listener listen");
  *poller = epoll_create1(EPOLL_CLOEXEC);
  if (*poller < 0)
    fail("host ingress epoll_create1");
  registration.data.fd = listener;
  if (epoll_ctl(*poller, EPOLL_CTL_ADD, listener, &registration) != 0)
    fail("host ingress epoll_ctl");
  dprintf(STDOUT_FILENO,
          "MINISANDBOX_PVM_HOST_INGRESS_WARM_READY port=%lu\n", port);
  return listener;
}

static void check_host_ingress_if_requested(int listener, int poller) {
  static const char request[] = "host-ingress";
  static const char response[] = "guest-ingress";
  struct sockaddr_in local = {0};
  struct sockaddr_in peer = {0};
  socklen_t local_length = sizeof(local);
  socklen_t peer_length = sizeof(peer);
  char received[sizeof(request)] = {0};
  int accepted;

  if (listener < 0)
    return;
  for (;;) {
    wait_epoll_mask(poller, listener, EPOLLIN, "host ingress epoll_wait");
    accepted = accept4(listener, (struct sockaddr *)&peer, &peer_length,
                       SOCK_CLOEXEC);
    if (accepted >= 0)
      break;
    if (errno != EAGAIN && errno != EWOULDBLOCK)
      fail("host ingress accept");
  }
  if (getsockname(accepted, (struct sockaddr *)&local, &local_length) != 0 ||
      local_length != sizeof(local) || local.sin_family != AF_INET ||
      local.sin_addr.s_addr != htonl(INADDR_LOOPBACK) || !local.sin_port)
    fail("host ingress getsockname");
  if (peer_length != sizeof(peer) || peer.sin_family != AF_INET ||
      !peer.sin_port)
    fail("host ingress peer endpoint");
  if (recv(accepted, received, sizeof(received), MSG_WAITALL) !=
          (ssize_t)sizeof(received) ||
      memcmp(received, request, sizeof(request)) != 0) {
    errno = EPROTO;
    fail("host ingress receive");
  }
  if (send(accepted, response, sizeof(response), 0) !=
      (ssize_t)sizeof(response))
    fail("host ingress send");
  close(accepted);
  close(poller);
  close(listener);
  dprintf(STDOUT_FILENO, "MINISANDBOX_PVM_HOST_INGRESS_OK\n");
}

static void check_cancelled_host_ingress_if_requested(int listener,
                                                       int poller) {
  int accepted;

  if (listener < 0)
    return;
  usleep(100000);
  accepted = accept4(listener, NULL, NULL, SOCK_CLOEXEC);
  if (accepted >= 0) {
    close(accepted);
    errno = EPROTO;
    fail("cancelled host ingress leaked to accept");
  }
  if (errno != EAGAIN && errno != EWOULDBLOCK)
    fail("cancelled host ingress accept result");
  close(poller);
  close(listener);
  dprintf(STDOUT_FILENO, "MINISANDBOX_PVM_HOST_INGRESS_CANCEL_OK\n");
}

static size_t build_dns_query(const char *host, unsigned char *query,
                              size_t capacity) {
  const char *label = host;
  unsigned char *cursor;

  if (capacity < 17)
    fail("DNS query capacity");
  memset(query, 0, capacity);
  write_be16(query, 0x5a31);
  write_be16(query + 2, 0x0100);
  write_be16(query + 4, 1);
  cursor = query + 12;
  while (*label) {
    const char *dot = strchr(label, '.');
    size_t length = dot ? (size_t)(dot - label) : strlen(label);

    if (!length || length > 63 ||
        (size_t)(cursor - query) + 1 + length + 5 > capacity)
      fail("DNS host name");
    *cursor++ = (unsigned char)length;
    memcpy(cursor, label, length);
    cursor += length;
    if (!dot)
      break;
    label = dot + 1;
  }
  *cursor++ = 0;
  write_be16(cursor, 1);
  cursor += 2;
  write_be16(cursor, 1);
  cursor += 2;
  return (size_t)(cursor - query);
}

static int skip_dns_name(const unsigned char *response, size_t length,
                         size_t *offset) {
  size_t cursor = *offset;

  while (cursor < length) {
    unsigned int label = response[cursor++];

    if (!label) {
      *offset = cursor;
      return 0;
    }
    if ((label & 0xc0U) == 0xc0U) {
      if (cursor >= length)
        return -1;
      *offset = cursor + 1;
      return 0;
    }
    if (label > 63 || cursor + label > length)
      return -1;
    cursor += label;
  }
  return -1;
}

static struct in_addr parse_dns_a_response(const unsigned char *response,
                                           size_t length) {
  struct in_addr result = {0};
  unsigned int questions;
  unsigned int answers;
  size_t offset = 12;
  unsigned int index;

  if (length < 12 || read_be16(response) != 0x5a31 ||
      (read_be16(response + 2) & 0x800fU) != 0x8000U)
    fail("DNS response header");
  questions = read_be16(response + 4);
  answers = read_be16(response + 6);
  if (questions != 1 || skip_dns_name(response, length, &offset) ||
      offset + 4 > length)
    fail("DNS response question");
  offset += 4;
  for (index = 0; index < answers; index++) {
    unsigned int type;
    unsigned int class;
    unsigned int data_length;

    if (skip_dns_name(response, length, &offset) || offset + 10 > length)
      fail("DNS response answer");
    type = read_be16(response + offset);
    class = read_be16(response + offset + 2);
    data_length = read_be16(response + offset + 8);
    offset += 10;
    if (offset + data_length > length)
      fail("DNS response data");
    if (type == 1 && class == 1 && data_length == 4) {
      memcpy(&result.s_addr, response + offset, 4);
      return result;
    }
    offset += data_length;
  }
  errno = ENOENT;
  fail("DNS A answer");
  return result;
}

static size_t build_tls_client_hello(const char *host, unsigned char *record,
                                     size_t capacity) {
  static const unsigned char cipher_suites[] = {
      0xc0, 0x2f, 0xc0, 0x2b, 0xcc, 0xa8, 0xcc, 0xa9, 0x00, 0x9c};
  static const unsigned char signature_algorithms[] = {
      0x04, 0x03, 0x08, 0x04, 0x04, 0x01, 0x05, 0x03, 0x05, 0x01};
  unsigned char *cursor = record + 9;
  unsigned char *body = cursor;
  unsigned char *extensions_length;
  unsigned char *extensions;
  size_t host_length = strlen(host);
  size_t index;

  if (!host_length || host_length > 253 || capacity < host_length + 128)
    fail("TLS host name");
  *cursor++ = 0x03;
  *cursor++ = 0x03;
  for (index = 0; index < 32; index++)
    *cursor++ = (unsigned char)index;
  *cursor++ = 0;
  write_be16(cursor, sizeof(cipher_suites));
  cursor += 2;
  memcpy(cursor, cipher_suites, sizeof(cipher_suites));
  cursor += sizeof(cipher_suites);
  *cursor++ = 1;
  *cursor++ = 0;
  extensions_length = cursor;
  cursor += 2;
  extensions = cursor;

  write_be16(cursor, 0);
  write_be16(cursor + 2, (uint16_t)(host_length + 5));
  write_be16(cursor + 4, (uint16_t)(host_length + 3));
  cursor[6] = 0;
  write_be16(cursor + 7, (uint16_t)host_length);
  memcpy(cursor + 9, host, host_length);
  cursor += 9 + host_length;

  write_be16(cursor, 13);
  write_be16(cursor + 2, sizeof(signature_algorithms) + 2);
  write_be16(cursor + 4, sizeof(signature_algorithms));
  memcpy(cursor + 6, signature_algorithms, sizeof(signature_algorithms));
  cursor += 6 + sizeof(signature_algorithms);
  memcpy(cursor, "\x00\x0a\x00\x06\x00\x04\x00\x1d\x00\x17", 10);
  cursor += 10;
  memcpy(cursor, "\x00\x0b\x00\x02\x01\x00\xff\x01\x00\x01\x00", 11);
  cursor += 11;

  write_be16(extensions_length, (uint16_t)(cursor - extensions));
  record[5] = 1;
  write_be24(record + 6, (size_t)(cursor - body));
  record[0] = 0x16;
  record[1] = 0x03;
  record[2] = 0x01;
  write_be16(record + 3, (uint16_t)(cursor - record - 5));
  return (size_t)(cursor - record);
}

static void check_public_network_if_requested(const char *command_line) {
  char resolver_text[INET_ADDRSTRLEN] = {0};
  char host[256] = {0};
  struct sockaddr_in resolver = {.sin_family = AF_INET,
                                 .sin_port = htons(53)};
  struct sockaddr_in https_peer = {.sin_family = AF_INET,
                                   .sin_port = htons(443)};
  unsigned char query[512];
  unsigned char response[4096];
  unsigned char hello[512];
  unsigned char tls_header[5];
  size_t query_length;
  size_t hello_length;
  ssize_t length;
  int socket_fd;

  if (!command_line_value(command_line, "pvm_dns_server=", resolver_text,
                          sizeof(resolver_text)))
    return;
  if (!command_line_value(command_line, "pvm_https_host=", host,
                          sizeof(host)))
    fail("missing HTTPS host");
  if (inet_pton(AF_INET, resolver_text, &resolver.sin_addr) != 1)
    fail("DNS resolver address");
  query_length = build_dns_query(host, query, sizeof(query));
  socket_fd = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, IPPROTO_UDP);
  if (socket_fd < 0)
    fail("PVM DNS socket");
  if (connect(socket_fd, (struct sockaddr *)&resolver, sizeof(resolver)) != 0)
    fail("PVM DNS connect");
  if (send(socket_fd, query, query_length, 0) != (ssize_t)query_length)
    fail("PVM DNS send");
  length = recv(socket_fd, response, sizeof(response), 0);
  if (length < 0)
    fail("PVM DNS receive");
  https_peer.sin_addr = parse_dns_a_response(response, (size_t)length);
  close(socket_fd);
  dprintf(STDOUT_FILENO, "MINISANDBOX_PVM_DNS_OK %s\n",
          inet_ntoa(https_peer.sin_addr));

  socket_fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, IPPROTO_TCP);
  if (socket_fd < 0)
    fail("PVM HTTPS socket");
  if (connect(socket_fd, (struct sockaddr *)&https_peer, sizeof(https_peer)) !=
      0)
    fail("PVM HTTPS connect");
  hello_length = build_tls_client_hello(host, hello, sizeof(hello));
  if (send(socket_fd, hello, hello_length, 0) != (ssize_t)hello_length)
    fail("PVM TLS ClientHello");
  if (recv(socket_fd, tls_header, sizeof(tls_header), MSG_WAITALL) !=
          (ssize_t)sizeof(tls_header) ||
      tls_header[0] != 0x16)
    fail("PVM TLS ServerHello");
  close(socket_fd);
  dprintf(STDOUT_FILENO, "MINISANDBOX_PVM_HTTPS_TCP_OK\n");
}

static void check_stream_mailbox_if_requested(void) {
  char command_line[1024] = {0};
  const char *option;

  read_kernel_command_line(command_line, sizeof(command_line));
  option = strstr(command_line, "pvm_socket_port=");
  if (option != NULL) {
    unsigned long port = strtoul(option + strlen("pvm_socket_port="), NULL, 10);
    struct sockaddr_in peer = {
        .sin_family = AF_INET,
        .sin_port = htons((uint16_t)port),
        .sin_addr.s_addr = htonl(PVM_HOST_LOOPBACK_ALIAS),
    };
    const char request[] = "guest-ping";
    char response[sizeof("host-pong")] = {0};
    int enabled = 1;
    int stream = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK,
                        IPPROTO_TCP);
    int poller;
    struct epoll_event registration = {
        .events = EPOLLIN | EPOLLOUT | EPOLLRDHUP | EPOLLET,
    };
    int socket_error = 0;
    socklen_t socket_error_length = sizeof(socket_error);
    size_t sent = 0;
    size_t received = 0;
    size_t stream_verified = 0;
    size_t close_tail_sent = 0;
    unsigned char stream_chunk[997];
    unsigned char close_tail[PVM_CLOSE_DRAIN_BYTES];

    if (port == 0 || port > UINT16_MAX)
      fail("PVM socket port");
    if (stream < 0)
      fail("PVM socket");
    poller = epoll_create1(EPOLL_CLOEXEC);
    if (poller < 0)
      fail("PVM socket epoll_create1");
    registration.data.fd = stream;
    if (epoll_ctl(poller, EPOLL_CTL_ADD, stream, &registration) != 0)
      fail("PVM socket epoll_ctl");
    if (setsockopt(stream, IPPROTO_TCP, TCP_NODELAY, &enabled,
                   sizeof(enabled)) != 0)
      fail("PVM TCP_NODELAY");
    if (connect(stream, (struct sockaddr *)&peer, sizeof(peer)) != 0 &&
        errno != EINPROGRESS)
      fail("PVM connect");
    wait_epoll_mask(poller, stream, EPOLLOUT | EPOLLERR | EPOLLHUP,
                    "PVM asynchronous connect wait");
    if (getsockopt(stream, SOL_SOCKET, SO_ERROR, &socket_error,
                   &socket_error_length) != 0 || socket_error) {
      errno = socket_error ? socket_error : errno;
      fail("PVM asynchronous connect");
    }
    while (sent < sizeof(request)) {
      ssize_t progress = send(stream, request + sent, sizeof(request) - sent,
                              MSG_DONTWAIT);

      if (progress > 0) {
        sent += (size_t)progress;
        continue;
      }
      if (progress < 0 && errno == EAGAIN) {
        wait_epoll_mask(poller, stream, EPOLLOUT | EPOLLERR | EPOLLHUP,
                        "PVM asynchronous send wait");
        continue;
      }
      fail("PVM asynchronous send");
    }
    while (received < sizeof(response)) {
      ssize_t progress = recv(stream, response + received,
                              sizeof(response) - received, MSG_DONTWAIT);

      if (progress > 0) {
        received += (size_t)progress;
        continue;
      }
      if (progress < 0 && errno == EAGAIN) {
        wait_epoll_mask(poller, stream,
                        EPOLLIN | EPOLLERR | EPOLLHUP | EPOLLRDHUP,
                        "PVM asynchronous receive wait");
        continue;
      }
      fail("PVM asynchronous receive");
    }
    if (memcmp(response, "host-pong", sizeof(response)) != 0)
      fail("PVM receive");
    while (stream_verified < PVM_STREAM_FIFO_BYTES) {
      size_t wanted = PVM_STREAM_FIFO_BYTES - stream_verified;
      ssize_t progress;

      if (wanted > sizeof(stream_chunk))
        wanted = sizeof(stream_chunk);
      progress = recv(stream, stream_chunk, wanted, MSG_DONTWAIT);
      if (progress > 0) {
        for (ssize_t index = 0; index < progress; index++) {
          size_t position = stream_verified + (size_t)index;
          unsigned char expected =
              (unsigned char)((position * 131U + 17U) % 251U);

          if (stream_chunk[index] != expected) {
            errno = EILSEQ;
            fail("PVM stream RX FIFO ordering");
          }
        }
        stream_verified += (size_t)progress;
        continue;
      }
      if (progress < 0 && errno == EAGAIN) {
        wait_epoll_mask(poller, stream,
                        EPOLLIN | EPOLLERR | EPOLLHUP | EPOLLRDHUP,
                        "PVM stream FIFO receive wait");
        continue;
      }
      fail("PVM stream FIFO receive");
    }
    for (size_t index = 0; index < sizeof(close_tail); index++)
      close_tail[index] = (unsigned char)((index * 73U + 41U) % 251U);
    while (close_tail_sent < sizeof(close_tail)) {
      ssize_t progress = send(stream, close_tail + close_tail_sent,
                              sizeof(close_tail) - close_tail_sent, 0);

      if (progress > 0) {
        close_tail_sent += (size_t)progress;
        continue;
      }
      fail("PVM close-drain send");
    }
    close(poller);
    close(stream);
    dprintf(STDOUT_FILENO, "MINISANDBOX_PVM_SOCKET_CLOSE_DRAIN_OK\n");
    dprintf(STDOUT_FILENO, "MINISANDBOX_PVM_SOCKET_STREAM_FIFO_OK\n");
    dprintf(STDOUT_FILENO, "MINISANDBOX_PVM_SOCKET_ASYNC_OK\n");
    dprintf(STDOUT_FILENO, "MINISANDBOX_PVM_SOCKET_OK\n");
  }
  option = strstr(command_line, "pvm_socket_refused_port=");
  if (option != NULL) {
    unsigned long port =
        strtoul(option + strlen("pvm_socket_refused_port="), NULL, 10);
    struct sockaddr_in peer = {
        .sin_family = AF_INET,
        .sin_port = htons((uint16_t)port),
        .sin_addr.s_addr = htonl(PVM_HOST_LOOPBACK_ALIAS),
    };
    int stream = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK,
                        IPPROTO_TCP);
    int poller = epoll_create1(EPOLL_CLOEXEC);
    struct epoll_event registration = {
        .events = EPOLLOUT | EPOLLERR | EPOLLHUP | EPOLLET,
        .data.fd = stream,
    };
    struct epoll_event after_error = {0};
    int socket_error = 0;
    socklen_t socket_error_length = sizeof(socket_error);
    int ready;

    if (port == 0 || port > UINT16_MAX || stream < 0 || poller < 0)
      fail("PVM refused socket setup");
    if (epoll_ctl(poller, EPOLL_CTL_ADD, stream, &registration) != 0)
      fail("PVM refused socket epoll_ctl");
    if (connect(stream, (struct sockaddr *)&peer, sizeof(peer)) != 0 &&
        errno != EINPROGRESS)
      fail("PVM refused connect submission");
    wait_epoll_mask(poller, stream, EPOLLERR | EPOLLHUP,
                    "PVM refused connect wait");
    if (getsockopt(stream, SOL_SOCKET, SO_ERROR, &socket_error,
                   &socket_error_length) != 0 ||
        socket_error != ECONNREFUSED) {
      errno = socket_error ? socket_error : EPROTO;
      fail("PVM refused connect SO_ERROR");
    }
    ready = epoll_wait(poller, &after_error, 1, 0);
    if (ready < 0 || (ready == 1 && (after_error.events & EPOLLERR))) {
      errno = EPROTO;
      fail("PVM consumed SO_ERROR readiness");
    }
    close(poller);
    close(stream);
    dprintf(STDOUT_FILENO, "MINISANDBOX_PVM_SOCKET_SO_ERROR_OK\n");
  }
  check_public_network_if_requested(command_line);
}

static void check_stream_lifecycle_if_requested(void) {
  char command_line[1024] = {0};
  const char *option;
  unsigned long port;
  struct sockaddr_in peer = {
      .sin_family = AF_INET,
      .sin_addr.s_addr = htonl(PVM_HOST_LOOPBACK_ALIAS),
  };
  const char host_payload[] = "before-fin";
  const char guest_payload[] = "after-fin";
  char received[sizeof(host_payload)] = {0};
  size_t received_bytes = 0;
  bool saw_eof = false;
  int stream;
  int poller;
  struct epoll_event registration;
  int socket_error;
  socklen_t socket_error_length;

  read_kernel_command_line(command_line, sizeof(command_line));
  option = strstr(command_line, "pvm_socket_lifecycle_port=");
  if (!option)
    return;
  port = strtoul(option + strlen("pvm_socket_lifecycle_port="), NULL, 10);
  if (!port || port > UINT16_MAX)
    fail("PVM lifecycle port");
  peer.sin_port = htons((uint16_t)port);

  stream = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK,
                  IPPROTO_TCP);
  poller = epoll_create1(EPOLL_CLOEXEC);
  registration = (struct epoll_event){
      .events = EPOLLIN | EPOLLOUT | EPOLLERR | EPOLLHUP | EPOLLRDHUP |
                EPOLLET,
      .data.fd = stream,
  };
  if (stream < 0 || poller < 0 ||
      epoll_ctl(poller, EPOLL_CTL_ADD, stream, &registration) != 0)
    fail("PVM lifecycle half-close setup");
  if (connect(stream, (struct sockaddr *)&peer, sizeof(peer)) != 0 &&
      errno != EINPROGRESS)
    fail("PVM lifecycle half-close connect");
  wait_epoll_mask(poller, stream, EPOLLOUT | EPOLLERR | EPOLLHUP,
                  "PVM lifecycle half-close connect wait");
  socket_error = 0;
  socket_error_length = sizeof(socket_error);
  if (getsockopt(stream, SOL_SOCKET, SO_ERROR, &socket_error,
                 &socket_error_length) != 0 || socket_error) {
    errno = socket_error ? socket_error : EPROTO;
    fail("PVM lifecycle half-close SO_ERROR");
  }
  while (!saw_eof) {
    char discard;
    void *destination = received_bytes < sizeof(received)
                            ? (void *)(received + received_bytes)
                            : (void *)&discard;
    size_t capacity = received_bytes < sizeof(received)
                          ? sizeof(received) - received_bytes
                          : sizeof(discard);
    ssize_t progress = recv(stream, destination, capacity, MSG_DONTWAIT);

    if (progress > 0) {
      if (received_bytes < sizeof(received))
        received_bytes += (size_t)progress;
      else {
        errno = EOVERFLOW;
        fail("PVM lifecycle bytes after expected payload");
      }
      continue;
    }
    if (progress == 0) {
      saw_eof = true;
      break;
    }
    if (errno == EAGAIN) {
      wait_epoll_mask(poller, stream,
                      EPOLLIN | EPOLLERR | EPOLLHUP | EPOLLRDHUP,
                      "PVM lifecycle peer FIN wait");
      continue;
    }
    fail("PVM lifecycle receive peer FIN");
  }
  if (received_bytes != sizeof(host_payload) ||
      memcmp(received, host_payload, sizeof(host_payload)) != 0) {
    errno = EILSEQ;
    fail("PVM lifecycle pre-FIN payload");
  }
  if (send(stream, guest_payload, sizeof(guest_payload), MSG_NOSIGNAL) !=
      (ssize_t)sizeof(guest_payload))
    fail("PVM lifecycle send after peer FIN");
  if (shutdown(stream, SHUT_WR) != 0)
    fail("PVM lifecycle SHUT_WR");
  errno = 0;
  if (send(stream, "x", 1, MSG_NOSIGNAL) >= 0 || errno != EPIPE) {
    errno = EPROTO;
    fail("PVM lifecycle send after SHUT_WR");
  }
  close(poller);
  close(stream);
  dprintf(STDOUT_FILENO, "MINISANDBOX_PVM_SOCKET_HALF_CLOSE_OK\n");

  stream = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK,
                  IPPROTO_TCP);
  poller = epoll_create1(EPOLL_CLOEXEC);
  registration = (struct epoll_event){
      .events = EPOLLIN | EPOLLOUT | EPOLLERR | EPOLLHUP | EPOLLRDHUP |
                EPOLLET,
      .data.fd = stream,
  };
  if (stream < 0 || poller < 0 ||
      epoll_ctl(poller, EPOLL_CTL_ADD, stream, &registration) != 0)
    fail("PVM lifecycle RST setup");
  if (connect(stream, (struct sockaddr *)&peer, sizeof(peer)) != 0 &&
      errno != EINPROGRESS)
    fail("PVM lifecycle RST connect");
  wait_epoll_mask(poller, stream, EPOLLOUT | EPOLLERR | EPOLLHUP,
                  "PVM lifecycle RST connect wait");
  socket_error = 0;
  socket_error_length = sizeof(socket_error);
  if (getsockopt(stream, SOL_SOCKET, SO_ERROR, &socket_error,
                 &socket_error_length) != 0 || socket_error) {
    errno = socket_error ? socket_error : EPROTO;
    fail("PVM lifecycle RST SO_ERROR");
  }
  if (send(stream, "R", 1, MSG_NOSIGNAL) != 1)
    fail("PVM lifecycle RST ready");
  for (;;) {
    char byte;
    ssize_t progress = recv(stream, &byte, sizeof(byte), MSG_DONTWAIT);

    if (progress < 0 && errno == ECONNRESET)
      break;
    if (progress < 0 && errno == EAGAIN) {
      wait_epoll_mask(poller, stream,
                      EPOLLIN | EPOLLERR | EPOLLHUP | EPOLLRDHUP,
                      "PVM lifecycle RST wait");
      continue;
    }
    errno = EPROTO;
    fail("PVM lifecycle RST result");
  }
  close(poller);
  close(stream);
  dprintf(STDOUT_FILENO, "MINISANDBOX_PVM_SOCKET_RST_OK\n");
}

static void publish_checkpoint(void) {
  if (mkdir("/dev", 0755) != 0 && errno != EEXIST)
    fail("mkdir /dev");
  if (mount("devtmpfs", "/dev", "devtmpfs", 0, NULL) != 0 && errno != EBUSY)
    fail("mount devtmpfs");
  int control = open("/dev/minisandbox", O_RDWR | O_CLOEXEC);
  if (control < 0)
    fail("open /dev/minisandbox");
  if (ioctl(control, _IO(0xb7, 1)) != 0)
    fail("checkpoint ioctl");
  close(control);
}

int main(int argument_count, char **arguments) {
  char command_line[1024] = {0};
  bool socket_checks_after_resume;
  struct sockaddr_in checkpoint_address;
  int checkpoint_listener;
  int ingress_cancel_listener;
  int ingress_cancel_poller;
  int ingress_listener;
  int ingress_poller;

  if (argument_count == 2 && strcmp(arguments[1], "--exec-child") == 0)
    return 0;

  read_kernel_command_line(command_line, sizeof(command_line));
  socket_checks_after_resume =
      strstr(command_line, "pvm_socket_after_resume=1") != NULL;
  dprintf(STDOUT_FILENO, "MINISANDBOX_PVM_LINUX_BOOT\n");
  check_process_and_pipe();
  check_exec();
  check_epoll();
  check_memory_signal_and_futex();
  check_local_loopback();
  if (!socket_checks_after_resume) {
    check_stream_mailbox_if_requested();
    check_stream_lifecycle_if_requested();
  }
  ingress_listener = prepare_host_ingress_listener_if_requested(
      command_line, "pvm_ingress_port=", &ingress_poller);
  ingress_cancel_listener = prepare_host_ingress_listener_if_requested(
      command_line, "pvm_ingress_cancel_port=", &ingress_cancel_poller);
  checkpoint_listener =
      prepare_local_checkpoint_listener(&checkpoint_address);
  dprintf(STDOUT_FILENO, "MINISANDBOX_PVM_LINUX_OK\n");
  publish_checkpoint();
  dprintf(STDOUT_FILENO, "MINISANDBOX_PVM_LINUX_RESUMED pid=%ld\n",
          (long)getpid());
  if (socket_checks_after_resume) {
    check_stream_mailbox_if_requested();
    check_stream_lifecycle_if_requested();
  }
  check_local_checkpoint_listener(checkpoint_listener, &checkpoint_address);
  check_cancelled_host_ingress_if_requested(ingress_cancel_listener,
                                             ingress_cancel_poller);
  check_host_ingress_if_requested(ingress_listener, ingress_poller);
  for (;;)
    pause();
}
