#define _GNU_SOURCE

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/socket.h>
#include <unistd.h>

#define CHECKPOINT_IOCTL 0xB701
#define BENCHMARK_POINT_IOCTL 0xB702
#define CONTROL_PATH "/dev/minisandbox"
#define MAX_CONNECTIONS 96U
#define INPUT_BYTES 8192U
#define OUTPUT_BYTES 4096U
#define SSE_EVENT_BYTES 512U
#define MAX_EVENTS 128U
#define WS_GUID "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

enum connection_kind { KIND_UNKNOWN, KIND_KEEPALIVE, KIND_SSE, KIND_WEBSOCKET };

struct connection {
  int fd;
  bool active;
  bool websocket_open;
  bool close_after_write;
  enum connection_kind kind;
  unsigned char input[INPUT_BYTES];
  size_t input_length;
  unsigned char output[OUTPUT_BYTES];
  size_t output_offset;
  size_t output_length;
  uint32_t keepalive_requests;
  uint32_t sse_events;
  uint32_t websocket_messages;
};

struct server {
  int listener;
  int poller;
  uint16_t port;
  uint32_t expected_connections;
  uint32_t keepalive_requests;
  uint32_t sse_events;
  uint32_t websocket_messages;
  uint32_t accepted;
  uint32_t completed;
  uint64_t send_eagain;
  uint64_t recv_eagain;
  struct connection connections[MAX_CONNECTIONS];
};

struct sha1_state {
  uint32_t words[5];
  uint64_t bytes;
  unsigned char block[64];
  size_t used;
};

static void stay_alive(void) {
  for (;;)
    pause();
}

static void write_line(const char *line) {
  size_t length = strlen(line);
  if (write(STDOUT_FILENO, line, length) != (ssize_t)length ||
      write(STDOUT_FILENO, "\n", 1) != 1)
    _exit(120);
}

static void fail(const char *operation) {
  char line[256];
  snprintf(line, sizeof(line), "MSLONG_FAIL operation=%s errno=%d error=%s",
           operation, errno, strerror(errno));
  write_line(line);
  write_line("MSLONG_DONE");
  stay_alive();
}

static void mount_if_needed(const char *source, const char *target,
                            const char *filesystem) {
  if (mount(source, target, filesystem, 0, NULL) != 0 && errno != EBUSY)
    fail(target);
}

static bool command_line_value(const char *name, char *value,
                               size_t capacity) {
  char command_line[4096];
  char prefix[96];
  ssize_t length;
  int file = open("/proc/cmdline", O_RDONLY | O_CLOEXEC);
  if (file < 0)
    fail("open /proc/cmdline");
  length = read(file, command_line, sizeof(command_line) - 1);
  close(file);
  if (length < 0)
    fail("read /proc/cmdline");
  command_line[length] = '\0';
  snprintf(prefix, sizeof(prefix), "mslong.%s=", name);
  for (char *token = strtok(command_line, " \n"); token;
       token = strtok(NULL, " \n")) {
    size_t prefix_length = strlen(prefix);
    size_t token_length;
    if (strncmp(token, prefix, prefix_length) != 0)
      continue;
    token += prefix_length;
    token_length = strlen(token);
    if (token_length + 1 > capacity) {
      errno = EOVERFLOW;
      fail("kernel command-line value");
    }
    memcpy(value, token, token_length + 1);
    return true;
  }
  return false;
}

static uint32_t command_line_u32(const char *name, uint32_t maximum) {
  char value[32];
  char *end = NULL;
  unsigned long parsed;
  if (!command_line_value(name, value, sizeof(value))) {
    errno = ENOENT;
    fail(name);
  }
  errno = 0;
  parsed = strtoul(value, &end, 10);
  if (errno || !end || *end || !parsed || parsed > maximum) {
    errno = EINVAL;
    fail(name);
  }
  return (uint32_t)parsed;
}

static uint32_t rotate_left(uint32_t value, unsigned int bits) {
  return (value << bits) | (value >> (32U - bits));
}

static void sha1_transform(struct sha1_state *state,
                           const unsigned char block[64]) {
  uint32_t words[80];
  for (unsigned int index = 0; index < 16; index++)
    words[index] = ((uint32_t)block[index * 4] << 24) |
                   ((uint32_t)block[index * 4 + 1] << 16) |
                   ((uint32_t)block[index * 4 + 2] << 8) |
                   (uint32_t)block[index * 4 + 3];
  for (unsigned int index = 16; index < 80; index++)
    words[index] = rotate_left(words[index - 3] ^ words[index - 8] ^
                                   words[index - 14] ^ words[index - 16],
                               1);
  uint32_t a = state->words[0];
  uint32_t b = state->words[1];
  uint32_t c = state->words[2];
  uint32_t d = state->words[3];
  uint32_t e = state->words[4];
  for (unsigned int index = 0; index < 80; index++) {
    uint32_t function;
    uint32_t constant;
    if (index < 20) {
      function = (b & c) | ((~b) & d);
      constant = 0x5a827999U;
    } else if (index < 40) {
      function = b ^ c ^ d;
      constant = 0x6ed9eba1U;
    } else if (index < 60) {
      function = (b & c) | (b & d) | (c & d);
      constant = 0x8f1bbcdcU;
    } else {
      function = b ^ c ^ d;
      constant = 0xca62c1d6U;
    }
    uint32_t temporary = rotate_left(a, 5) + function + e + constant +
                         words[index];
    e = d;
    d = c;
    c = rotate_left(b, 30);
    b = a;
    a = temporary;
  }
  state->words[0] += a;
  state->words[1] += b;
  state->words[2] += c;
  state->words[3] += d;
  state->words[4] += e;
}

static void sha1_update(struct sha1_state *state, const unsigned char *bytes,
                        size_t length) {
  state->bytes += length;
  while (length) {
    size_t amount = 64 - state->used;
    if (amount > length)
      amount = length;
    memcpy(state->block + state->used, bytes, amount);
    state->used += amount;
    bytes += amount;
    length -= amount;
    if (state->used == 64) {
      sha1_transform(state, state->block);
      state->used = 0;
    }
  }
}

static void sha1(const unsigned char *bytes, size_t length,
                 unsigned char digest[20]) {
  struct sha1_state state = {
      .words = {0x67452301U, 0xefcdab89U, 0x98badcfeU, 0x10325476U,
                0xc3d2e1f0U},
  };
  sha1_update(&state, bytes, length);
  uint64_t bits = state.bytes * 8U;
  unsigned char padding[72] = {0x80};
  size_t padding_length = state.used < 56 ? 56 - state.used : 120 - state.used;
  sha1_update(&state, padding, padding_length);
  unsigned char encoded_length[8];
  for (unsigned int index = 0; index < 8; index++)
    encoded_length[7 - index] = (unsigned char)(bits >> (index * 8));
  sha1_update(&state, encoded_length, sizeof(encoded_length));
  for (unsigned int index = 0; index < 5; index++) {
    digest[index * 4] = (unsigned char)(state.words[index] >> 24);
    digest[index * 4 + 1] = (unsigned char)(state.words[index] >> 16);
    digest[index * 4 + 2] = (unsigned char)(state.words[index] >> 8);
    digest[index * 4 + 3] = (unsigned char)state.words[index];
  }
}

static void base64_20(const unsigned char input[20], char output[29]) {
  static const char alphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  size_t input_offset = 0;
  size_t output_offset = 0;
  while (input_offset + 3 <= 20) {
    uint32_t value = ((uint32_t)input[input_offset] << 16) |
                     ((uint32_t)input[input_offset + 1] << 8) |
                     input[input_offset + 2];
    output[output_offset++] = alphabet[(value >> 18) & 63U];
    output[output_offset++] = alphabet[(value >> 12) & 63U];
    output[output_offset++] = alphabet[(value >> 6) & 63U];
    output[output_offset++] = alphabet[value & 63U];
    input_offset += 3;
  }
  uint32_t value = (uint32_t)input[input_offset] << 16 |
                   (uint32_t)input[input_offset + 1] << 8;
  output[output_offset++] = alphabet[(value >> 18) & 63U];
  output[output_offset++] = alphabet[(value >> 12) & 63U];
  output[output_offset++] = alphabet[(value >> 6) & 63U];
  output[output_offset++] = '=';
  output[output_offset] = '\0';
}

static unsigned char *find_bytes(unsigned char *bytes, size_t length,
                                 const char *needle) {
  size_t needle_length = strlen(needle);
  if (needle_length > length)
    return NULL;
  for (size_t offset = 0; offset + needle_length <= length; offset++)
    if (memcmp(bytes + offset, needle, needle_length) == 0)
      return bytes + offset;
  return NULL;
}

static void consume_input(struct connection *connection, size_t bytes) {
  if (bytes > connection->input_length)
    fail("consume input bounds");
  memmove(connection->input, connection->input + bytes,
          connection->input_length - bytes);
  connection->input_length -= bytes;
}

static void set_output(struct connection *connection, const void *bytes,
                       size_t length) {
  if (connection->output_offset != connection->output_length ||
      length > sizeof(connection->output)) {
    errno = ENOBUFS;
    fail("bounded connection output");
  }
  memcpy(connection->output, bytes, length);
  connection->output_offset = 0;
  connection->output_length = length;
}

static bool protocol_complete(const struct server *server,
                              const struct connection *connection) {
  switch (connection->kind) {
  case KIND_KEEPALIVE:
    return connection->keepalive_requests == server->keepalive_requests;
  case KIND_SSE:
    return connection->sse_events == server->sse_events;
  case KIND_WEBSOCKET:
    return connection->websocket_messages == server->websocket_messages;
  case KIND_UNKNOWN:
    return false;
  }
  return false;
}

static void close_connection(struct server *server,
                             struct connection *connection) {
  if (!connection->active)
    return;
  if (!protocol_complete(server, connection)) {
    errno = EPROTO;
    fail("peer closed incomplete protocol");
  }
  epoll_ctl(server->poller, EPOLL_CTL_DEL, connection->fd, NULL);
  close(connection->fd);
  connection->active = false;
  server->completed++;
}

static void update_interest(struct server *server, uint32_t index) {
  struct connection *connection = &server->connections[index];
  struct epoll_event event = {
      .events = EPOLLIN | EPOLLRDHUP | EPOLLET,
      .data.u32 = index + 1,
  };
  if (connection->output_offset < connection->output_length ||
      (connection->kind == KIND_SSE &&
       connection->sse_events < server->sse_events))
    event.events |= EPOLLOUT;
  if (epoll_ctl(server->poller, EPOLL_CTL_MOD, connection->fd, &event) != 0)
    fail("epoll modify connection");
}

static void queue_sse_event(struct connection *connection) {
  char prefix[32];
  int prefix_length = snprintf(prefix, sizeof(prefix), "data: %06u ",
                               connection->sse_events);
  if (prefix_length <= 0 || (size_t)prefix_length + 2 > SSE_EVENT_BYTES)
    fail("format SSE prefix");
  memset(connection->output, 'a' + (connection->sse_events % 26),
         SSE_EVENT_BYTES);
  memcpy(connection->output, prefix, (size_t)prefix_length);
  connection->output[SSE_EVENT_BYTES - 2] = '\n';
  connection->output[SSE_EVENT_BYTES - 1] = '\n';
  connection->output_offset = 0;
  connection->output_length = SSE_EVENT_BYTES;
  connection->sse_events++;
}

static void flush_output(struct server *server,
                         struct connection *connection) {
  while (connection->active) {
    if (connection->output_offset == connection->output_length) {
      connection->output_offset = 0;
      connection->output_length = 0;
      if (connection->kind == KIND_SSE &&
          connection->sse_events < server->sse_events)
        queue_sse_event(connection);
      else if (connection->close_after_write) {
        close_connection(server, connection);
        return;
      } else
        return;
    }
    ssize_t written = send(connection->fd,
                           connection->output + connection->output_offset,
                           connection->output_length - connection->output_offset,
                           MSG_DONTWAIT | MSG_NOSIGNAL);
    if (written > 0) {
      connection->output_offset += (size_t)written;
      continue;
    }
    if (written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      server->send_eagain++;
      return;
    }
    if (written < 0 && (errno == ECONNRESET || errno == EPIPE)) {
      close_connection(server, connection);
      return;
    }
    fail("connection send");
  }
}

static void queue_websocket_accept(struct connection *connection,
                                   unsigned char *header, size_t header_length) {
  unsigned char *key = find_bytes(header, header_length, "Sec-WebSocket-Key:");
  if (!key) {
    errno = EPROTO;
    fail("WebSocket key");
  }
  key += strlen("Sec-WebSocket-Key:");
  while (key < header + header_length && (*key == ' ' || *key == '\t'))
    key++;
  unsigned char *end = find_bytes(key, (size_t)(header + header_length - key), "\r\n");
  if (!end || end == key || (size_t)(end - key) > 64) {
    errno = EPROTO;
    fail("WebSocket key bounds");
  }
  unsigned char source[128];
  size_t key_length = (size_t)(end - key);
  memcpy(source, key, key_length);
  memcpy(source + key_length, WS_GUID, strlen(WS_GUID));
  unsigned char digest[20];
  char encoded[29];
  sha1(source, key_length + strlen(WS_GUID), digest);
  base64_20(digest, encoded);
  char response[256];
  int length = snprintf(response, sizeof(response),
                        "HTTP/1.1 101 Switching Protocols\r\n"
                        "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                        "Sec-WebSocket-Accept: %s\r\n\r\n",
                        encoded);
  if (length <= 0 || (size_t)length >= sizeof(response))
    fail("WebSocket response");
  set_output(connection, response, (size_t)length);
  connection->websocket_open = true;
}

static bool process_http(struct server *server,
                         struct connection *connection) {
  unsigned char *end = find_bytes(connection->input, connection->input_length,
                                  "\r\n\r\n");
  if (!end || connection->output_offset < connection->output_length)
    return false;
  size_t header_length = (size_t)(end - connection->input) + 4;
  if (find_bytes(connection->input, header_length, "GET /keepalive ")) {
    static const char response[] =
        "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n"
        "Content-Type: text/plain\r\nConnection: keep-alive\r\n\r\nok";
    if (connection->kind != KIND_UNKNOWN && connection->kind != KIND_KEEPALIVE)
      fail("mixed HTTP protocol");
    connection->kind = KIND_KEEPALIVE;
    if (++connection->keepalive_requests > server->keepalive_requests)
      fail("too many keep-alive requests");
    set_output(connection, response, sizeof(response) - 1);
  } else if (find_bytes(connection->input, header_length, "GET /sse ")) {
    static const char response[] =
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n"
        "Cache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n";
    if (connection->kind != KIND_UNKNOWN)
      fail("reused SSE connection");
    connection->kind = KIND_SSE;
    set_output(connection, response, sizeof(response) - 1);
  } else if (find_bytes(connection->input, header_length, "GET /ws ")) {
    if (connection->kind != KIND_UNKNOWN)
      fail("reused WebSocket connection");
    connection->kind = KIND_WEBSOCKET;
    queue_websocket_accept(connection, connection->input, header_length);
  } else {
    errno = EPROTO;
    fail("HTTP request target");
  }
  consume_input(connection, header_length);
  return true;
}

static bool process_websocket(struct server *server,
                              struct connection *connection) {
  if (!connection->websocket_open ||
      connection->output_offset < connection->output_length ||
      connection->input_length < 6)
    return false;
  unsigned char first = connection->input[0];
  unsigned char second = connection->input[1];
  uint64_t payload_length = second & 0x7fU;
  size_t offset = 2;
  if (!(second & 0x80U)) {
    errno = EPROTO;
    fail("unmasked WebSocket client frame");
  }
  if (payload_length == 126) {
    if (connection->input_length < 8)
      return false;
    payload_length = ((uint64_t)connection->input[2] << 8) | connection->input[3];
    offset = 4;
  } else if (payload_length == 127) {
    errno = EMSGSIZE;
    fail("oversized WebSocket frame");
  }
  if (payload_length > OUTPUT_BYTES - 4 ||
      connection->input_length < offset + 4 + payload_length)
    return false;
  unsigned char *mask = connection->input + offset;
  unsigned char opcode = first & 0x0fU;
  unsigned char *payload = connection->input + offset + 4;
  for (uint64_t index = 0; index < payload_length; index++)
    payload[index] ^= mask[index % 4];
  if (opcode == 8) {
    const unsigned char close_frame[2] = {0x88, 0};
    set_output(connection, close_frame, sizeof(close_frame));
    connection->close_after_write = true;
  } else if (opcode == 1 || opcode == 2) {
    if (++connection->websocket_messages > server->websocket_messages)
      fail("too many WebSocket messages");
    size_t header = payload_length < 126 ? 2 : 4;
    connection->output[0] = (unsigned char)(0x80U | opcode);
    if (payload_length < 126)
      connection->output[1] = (unsigned char)payload_length;
    else {
      connection->output[1] = 126;
      connection->output[2] = (unsigned char)(payload_length >> 8);
      connection->output[3] = (unsigned char)payload_length;
    }
    memmove(connection->output + header, payload, (size_t)payload_length);
    connection->output_offset = 0;
    connection->output_length = header + (size_t)payload_length;
  } else {
    errno = EPROTONOSUPPORT;
    fail("WebSocket opcode");
  }
  consume_input(connection, offset + 4 + (size_t)payload_length);
  return true;
}

static bool process_one(struct server *server,
                        struct connection *connection) {
  if (connection->kind == KIND_WEBSOCKET)
    return process_websocket(server, connection);
  return process_http(server, connection);
}

static void read_connection(struct server *server,
                            struct connection *connection) {
  while (connection->active) {
    if (connection->input_length == sizeof(connection->input)) {
      errno = ENOBUFS;
      fail("bounded connection input");
    }
    ssize_t received = recv(connection->fd,
                            connection->input + connection->input_length,
                            sizeof(connection->input) - connection->input_length,
                            MSG_DONTWAIT);
    if (received > 0) {
      connection->input_length += (size_t)received;
      continue;
    }
    if (received == 0) {
      close_connection(server, connection);
      return;
    }
    if (errno == EAGAIN || errno == EWOULDBLOCK) {
      server->recv_eagain++;
      return;
    }
    if (errno == ECONNRESET) {
      close_connection(server, connection);
      return;
    }
    fail("connection recv");
  }
}

static void service_connection(struct server *server, uint32_t index,
                               uint32_t events) {
  struct connection *connection = &server->connections[index];
  if (!connection->active)
    return;
  if (events & (EPOLLIN | EPOLLRDHUP | EPOLLHUP | EPOLLERR))
    read_connection(server, connection);
  if (!connection->active)
    return;
  for (unsigned int turn = 0; turn < 1024; turn++) {
    bool progressed = process_one(server, connection);
    flush_output(server, connection);
    if (!connection->active)
      return;
    if (!progressed && connection->output_offset == connection->output_length)
      break;
    if (connection->output_offset < connection->output_length)
      break;
  }
  update_interest(server, index);
}

static void accept_connections(struct server *server) {
  while (server->accepted < server->expected_connections) {
    struct sockaddr_in peer;
    socklen_t peer_length = sizeof(peer);
    int stream = accept4(server->listener, (struct sockaddr *)&peer, &peer_length,
                         SOCK_CLOEXEC | SOCK_NONBLOCK);
    if (stream < 0 && (errno == EAGAIN || errno == EWOULDBLOCK))
      return;
    if (stream < 0)
      fail("accept4");
    uint32_t index;
    for (index = 0; index < MAX_CONNECTIONS; index++)
      if (!server->connections[index].active)
        break;
    if (index == MAX_CONNECTIONS) {
      close(stream);
      errno = EMFILE;
      fail("connection table full");
    }
    memset(&server->connections[index], 0, sizeof(server->connections[index]));
    server->connections[index].fd = stream;
    server->connections[index].active = true;
    struct epoll_event event = {
        .events = EPOLLIN | EPOLLRDHUP | EPOLLET,
        .data.u32 = index + 1,
    };
    if (epoll_ctl(server->poller, EPOLL_CTL_ADD, stream, &event) != 0)
      fail("epoll add connection");
    server->accepted++;
  }
}

static void run_server(struct server *server) {
  struct epoll_event events[MAX_EVENTS];
  while (server->completed < server->expected_connections) {
    int count = epoll_wait(server->poller, events, MAX_EVENTS, -1);
    if (count < 0 && errno == EINTR)
      continue;
    if (count < 0)
      fail("epoll_wait");
    for (int event_index = 0; event_index < count; event_index++) {
      uint32_t token = events[event_index].data.u32;
      if (token == 0)
        accept_connections(server);
      else if (token <= MAX_CONNECTIONS)
        service_connection(server, token - 1, events[event_index].events);
      else {
        errno = EPROTO;
        fail("epoll token");
      }
    }
  }
}

int main(void) {
  mount_if_needed("devtmpfs", "/dev", "devtmpfs");
  mount_if_needed("proc", "/proc", "proc");
  mount_if_needed("sysfs", "/sys", "sysfs");
  struct server server = {
      .port = (uint16_t)command_line_u32("port", UINT16_MAX),
      .expected_connections = command_line_u32("connections", MAX_CONNECTIONS),
      .keepalive_requests = command_line_u32("keepalive", 10000),
      .sse_events = command_line_u32("sse", 100000),
      .websocket_messages = command_line_u32("websocket", 10000),
  };
  struct sockaddr_in address = {
      .sin_family = AF_INET,
      .sin_port = htons(server.port),
      .sin_addr.s_addr = htonl(INADDR_LOOPBACK),
  };
  server.listener =
      socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, IPPROTO_TCP);
  if (server.listener < 0 ||
      bind(server.listener, (struct sockaddr *)&address, sizeof(address)) != 0 ||
      listen(server.listener, 64) != 0)
    fail("prepare listener");
  server.poller = epoll_create1(EPOLL_CLOEXEC);
  struct epoll_event listener_event = {
      .events = EPOLLIN | EPOLLET,
      .data.u32 = 0,
  };
  if (server.poller < 0 ||
      epoll_ctl(server.poller, EPOLL_CTL_ADD, server.listener,
                &listener_event) != 0)
    fail("prepare epoll");

  int control = open(CONTROL_PATH, O_RDWR | O_CLOEXEC);
  if (control < 0)
    fail("open " CONTROL_PATH);
  write_line("MSLONG_WARM");
  if (ioctl(control, CHECKPOINT_IOCTL, 0) != 0)
    fail("checkpoint ioctl");
  if (ioctl(control, BENCHMARK_POINT_IOCTL, 0) != 0)
    fail("benchmark-point ioctl");
  write_line("MSLONG_RESUMED");
  run_server(&server);
  char result[256];
  snprintf(result, sizeof(result),
           "MSLONG_RESULT accepted=%u completed=%u send_eagain=%llu "
           "recv_eagain=%llu",
           server.accepted, server.completed,
           (unsigned long long)server.send_eagain,
           (unsigned long long)server.recv_eagain);
  write_line(result);
  write_line("MSLONG_DONE");
  close(control);
  stay_alive();
}
