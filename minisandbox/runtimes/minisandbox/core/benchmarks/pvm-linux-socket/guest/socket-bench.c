#define _GNU_SOURCE

#include <arpa/inet.h>
#include <endian.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <netinet/in.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#define CHECKPOINT_IOCTL 0xB701
#define BENCHMARK_POINT_IOCTL 0xB702
#define CONTROL_PATH "/dev/minisandbox"
#define MAX_IO_SIZE (1024U * 1024U)
#define MAX_CONNECTIONS 128U
#define MAX_RR_ITERATIONS 1000000ULL
#define MAX_RR_RATE 100000ULL
#define MAX_RR_SAMPLES 4000000ULL
#define MIN_RATE_DURATION_MS 100U
#define MAX_RATE_DURATION_MS 60000U
#define MAX_STREAM_BYTES (16ULL * 1024ULL * 1024ULL * 1024ULL)
#define MAX_GUEST_BUFFER_BYTES (128ULL * 1024ULL * 1024ULL)
#define READY_BYTE 0xA5U
#define START_BYTE 0x5AU
#define HOST_LOOPBACK_ALIAS 0xc0000201U

enum benchmark_mode {
  MODE_TCP_RR = 1,
  MODE_TCP_STREAM_TX = 2,
  MODE_TCP_STREAM_RX = 3,
  MODE_TCP_RR_RATE = 4,
};

struct wire_header {
  unsigned char magic[8];
  uint32_t mode_be;
  uint32_t io_size_be;
  uint64_t amount_be;
  uint32_t warmup_be;
  uint32_t seed_be;
} __attribute__((packed));

struct benchmark_config {
  enum benchmark_mode mode;
  bool ingress;
  uint16_t port;
  int listener_fd;
  uint32_t io_size;
  uint32_t connections;
  uint32_t warmup;
  uint64_t amount;
};

struct worker_result {
  struct benchmark_config *config;
  pthread_barrier_t *barrier;
  uint32_t seed;
  uint64_t start_ns;
  uint64_t end_ns;
  uint64_t send_calls;
  uint64_t recv_calls;
  uint64_t checksum;
  uint64_t late_operations;
  uint64_t *samples;
  int error_number;
  char error[96];
};

static const unsigned char header_magic[8] = {'M', 'S', 'N', 'E',
                                               'T', '0', '0', '1'};

static void write_line(const char *line) {
  size_t length = strlen(line);

  if (write(STDOUT_FILENO, line, length) != (ssize_t)length ||
      write(STDOUT_FILENO, "\n", 1) != 1) {
    _exit(120);
  }
}

static void stay_alive(void) {
  for (;;)
    pause();
}

static void fail(const char *operation) {
  char line[256];

  snprintf(line, sizeof(line), "MSSOCKBENCH_FAIL operation=%s errno=%d error=%s",
           operation, errno, strerror(errno));
  write_line(line);
  write_line("MSSOCKBENCH_DONE");
  stay_alive();
}

static uint64_t monotonic_ns(void) {
  struct timespec value;

  if (clock_gettime(CLOCK_MONOTONIC, &value) != 0)
    fail("clock_gettime");
  return (uint64_t)value.tv_sec * 1000000000ULL + (uint64_t)value.tv_nsec;
}

static int sleep_until(uint64_t deadline_ns) {
  struct timespec deadline = {
      .tv_sec = (time_t)(deadline_ns / 1000000000ULL),
      .tv_nsec = (long)(deadline_ns % 1000000000ULL),
  };
  int result;

  do {
    result = clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &deadline, NULL);
  } while (result == EINTR);
  if (result != 0) {
    errno = result;
    return -1;
  }
  return 0;
}

static bool is_rr_mode(enum benchmark_mode mode) {
  return mode == MODE_TCP_RR || mode == MODE_TCP_RR_RATE;
}

static uint64_t measured_rr_iterations(const struct benchmark_config *config) {
  if (config->mode == MODE_TCP_RR_RATE)
    return config->amount * config->warmup / 1000ULL;
  return config->amount;
}

static void mount_if_needed(const char *source, const char *target,
                            const char *filesystem) {
  if (mount(source, target, filesystem, 0, NULL) != 0 && errno != EBUSY)
    fail(target);
}

static bool command_line_value(const char *name, char *value,
                               size_t value_capacity) {
  char command_line[4096];
  char prefix[96];
  ssize_t length;
  int file;

  file = open("/proc/cmdline", O_RDONLY | O_CLOEXEC);
  if (file < 0)
    fail("open /proc/cmdline");
  length = read(file, command_line, sizeof(command_line) - 1);
  close(file);
  if (length < 0)
    fail("read /proc/cmdline");
  command_line[length] = '\0';
  snprintf(prefix, sizeof(prefix), "mssock.%s=", name);
  for (char *token = strtok(command_line, " \n"); token;
       token = strtok(NULL, " \n")) {
    size_t prefix_length = strlen(prefix);
    size_t token_length;

    if (strncmp(token, prefix, prefix_length) != 0)
      continue;
    token += prefix_length;
    token_length = strlen(token);
    if (token_length + 1 > value_capacity) {
      errno = EOVERFLOW;
      fail("kernel command-line value");
    }
    memcpy(value, token, token_length + 1);
    return true;
  }
  return false;
}

static uint64_t command_line_u64(const char *name) {
  char value[64];
  char *end = NULL;
  unsigned long long parsed;

  if (!command_line_value(name, value, sizeof(value))) {
    errno = ENOENT;
    fail(name);
  }
  errno = 0;
  parsed = strtoull(value, &end, 10);
  if (errno || !end || *end != '\0') {
    errno = EINVAL;
    fail(name);
  }
  return (uint64_t)parsed;
}

static struct benchmark_config read_config(void) {
  struct benchmark_config config;
  char mode[32];
  uint64_t port;
  uint64_t io_size;
  uint64_t connections;
  uint64_t warmup;

  if (!command_line_value("mode", mode, sizeof(mode))) {
    errno = ENOENT;
    fail("mssock.mode");
  }
  config.ingress = strncmp(mode, "ingress-", 8) == 0;
  if (config.ingress)
    memmove(mode, mode + 8, strlen(mode + 8) + 1);
  if (strcmp(mode, "tcp-rr") == 0)
    config.mode = MODE_TCP_RR;
  else if (strcmp(mode, "tcp-rr-rate") == 0)
    config.mode = MODE_TCP_RR_RATE;
  else if (strcmp(mode, "tcp-stream-tx") == 0)
    config.mode = MODE_TCP_STREAM_TX;
  else if (strcmp(mode, "tcp-stream-rx") == 0)
    config.mode = MODE_TCP_STREAM_RX;
  else {
    errno = EINVAL;
    fail("mssock.mode");
  }
  port = command_line_u64("port");
  io_size = command_line_u64("io_size");
  connections = command_line_u64("connections");
  warmup = command_line_u64("warmup");
  config.amount = command_line_u64("amount");
  if (!port || port > UINT16_MAX || !io_size || io_size > MAX_IO_SIZE ||
      !connections || connections > MAX_CONNECTIONS || warmup > UINT32_MAX ||
      !config.amount ||
      (config.mode == MODE_TCP_RR &&
       (config.amount > MAX_RR_ITERATIONS ||
        config.amount > MAX_RR_SAMPLES / connections)) ||
      (config.mode == MODE_TCP_RR_RATE &&
       (config.amount > MAX_RR_RATE || warmup < MIN_RATE_DURATION_MS ||
        warmup > MAX_RATE_DURATION_MS ||
        config.amount * warmup / 1000ULL == 0 ||
        config.amount * warmup / 1000ULL > MAX_RR_SAMPLES / connections)) ||
      (config.mode != MODE_TCP_RR && config.mode != MODE_TCP_RR_RATE &&
       config.amount > MAX_STREAM_BYTES) ||
      io_size > MAX_GUEST_BUFFER_BYTES / 2ULL / connections) {
    errno = EINVAL;
    fail("benchmark configuration bounds");
  }
  config.port = (uint16_t)port;
  config.listener_fd = -1;
  config.io_size = (uint32_t)io_size;
  config.connections = (uint32_t)connections;
  config.warmup = (uint32_t)warmup;
  return config;
}

static unsigned char pattern_byte(uint64_t position, uint32_t seed) {
  return (unsigned char)((position * 131ULL + (uint64_t)seed * 17ULL + 29ULL) %
                         251ULL);
}

static void fill_pattern(unsigned char *buffer, size_t length, uint64_t offset,
                         uint32_t seed) {
  for (size_t index = 0; index < length; index++)
    buffer[index] = pattern_byte(offset + index, seed);
}

static bool verify_pattern(const unsigned char *buffer, size_t length,
                           uint64_t offset, uint32_t seed,
                           uint64_t *checksum) {
  for (size_t index = 0; index < length; index++) {
    if (buffer[index] != pattern_byte(offset + index, seed))
      return false;
    *checksum += buffer[index];
  }
  return true;
}

static int send_exact(int socket_fd, const void *buffer, size_t length,
                      uint64_t *calls) {
  const unsigned char *bytes = buffer;
  size_t sent = 0;

  while (sent < length) {
    ssize_t progress = send(socket_fd, bytes + sent, length - sent, MSG_NOSIGNAL);

    if (calls)
      (*calls)++;
    if (progress > 0) {
      sent += (size_t)progress;
      continue;
    }
    if (progress < 0 && errno == EINTR)
      continue;
    return -1;
  }
  return 0;
}

static int recv_exact(int socket_fd, void *buffer, size_t length,
                      uint64_t *calls) {
  unsigned char *bytes = buffer;
  size_t received = 0;

  while (received < length) {
    ssize_t progress = recv(socket_fd, bytes + received, length - received, 0);

    if (calls)
      (*calls)++;
    if (progress > 0) {
      received += (size_t)progress;
      continue;
    }
    if (progress < 0 && errno == EINTR)
      continue;
    if (progress == 0)
      errno = ECONNRESET;
    return -1;
  }
  return 0;
}

static void worker_error(struct worker_result *worker, const char *operation) {
  worker->error_number = errno ? errno : EIO;
  snprintf(worker->error, sizeof(worker->error), "%s", operation);
}

static int connect_server(const struct worker_result *worker) {
  struct sockaddr_in address = {
      .sin_family = AF_INET,
      .sin_port = htons(worker->config->port),
      .sin_addr.s_addr = htonl(HOST_LOOPBACK_ALIAS),
  };
  int socket_fd;

  if (worker->config->ingress)
    return accept4(worker->config->listener_fd, NULL, NULL, SOCK_CLOEXEC);

  socket_fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);

  if (socket_fd < 0)
    return -1;
  if (connect(socket_fd, (struct sockaddr *)&address, sizeof(address)) != 0) {
    int saved_error = errno;
    close(socket_fd);
    errno = saved_error;
    return -1;
  }
  return socket_fd;
}

static int prepare_ingress_listener(const struct benchmark_config *config) {
  struct sockaddr_in address = {
      .sin_family = AF_INET,
      .sin_port = htons(config->port),
      .sin_addr.s_addr = htonl(INADDR_LOOPBACK),
  };
  int socket_fd;

  if (!config->ingress)
    return -1;
  socket_fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (socket_fd < 0)
    return -1;
  if (bind(socket_fd, (struct sockaddr *)&address, sizeof(address)) != 0 ||
      listen(socket_fd, (int)config->connections) != 0) {
    int saved_error = errno;
    close(socket_fd);
    errno = saved_error;
    return -1;
  }
  return socket_fd;
}

static int exchange_header(int socket_fd, const struct worker_result *worker) {
  struct wire_header header = {
      .mode_be = htonl((uint32_t)worker->config->mode),
      .io_size_be = htonl(worker->config->io_size),
      .amount_be = htobe64(worker->config->amount),
      .warmup_be = htonl(worker->config->warmup),
      .seed_be = htonl(worker->seed),
  };
  unsigned char ready = 0;

  memcpy(header.magic, header_magic, sizeof(header.magic));
  if (send_exact(socket_fd, &header, sizeof(header), NULL) != 0 ||
      recv_exact(socket_fd, &ready, sizeof(ready), NULL) != 0)
    return -1;
  if (ready != READY_BYTE) {
    errno = EPROTO;
    return -1;
  }
  return 0;
}

static int run_rr(int socket_fd, struct worker_result *worker,
                  unsigned char *send_buffer, unsigned char *receive_buffer) {
  bool fixed_rate = worker->config->mode == MODE_TCP_RR_RATE;
  uint64_t measured = measured_rr_iterations(worker->config);
  uint64_t warmup = fixed_rate ? 0 : worker->config->warmup;
  uint64_t total = measured + warmup;
  uint64_t pacing_started = 0;

  fill_pattern(send_buffer, worker->config->io_size, 0, worker->seed);
  if (fixed_rate) {
    pacing_started = monotonic_ns();
    worker->start_ns = pacing_started;
  }
  for (uint64_t iteration = 0; iteration < total; iteration++) {
    bool record = iteration >= warmup;
    uint64_t started = 0;
    uint64_t *send_calls = record ? &worker->send_calls : NULL;
    uint64_t *recv_calls = record ? &worker->recv_calls : NULL;

    if (fixed_rate) {
      uint64_t interval = 1000000000ULL / worker->config->amount;
      uint64_t deadline = pacing_started +
                          (iteration + 1) * 1000000000ULL /
                              worker->config->amount;
      uint64_t now = monotonic_ns();

      if (now < deadline && sleep_until(deadline) != 0)
        return -1;
      started = monotonic_ns();
      if (started > deadline + interval)
        worker->late_operations++;
    } else if (record) {
      if (iteration == warmup)
        worker->start_ns = monotonic_ns();
      started = monotonic_ns();
    }
    if (send_exact(socket_fd, send_buffer, worker->config->io_size,
                   send_calls) != 0 ||
        recv_exact(socket_fd, receive_buffer, worker->config->io_size,
                   recv_calls) != 0)
      return -1;
    if (memcmp(send_buffer, receive_buffer, worker->config->io_size) != 0) {
      errno = EILSEQ;
      return -1;
    }
    if (record) {
      uint64_t ended = monotonic_ns();

      worker->samples[iteration - warmup] = ended - started;
      worker->end_ns = ended;
      worker->checksum += receive_buffer[iteration % worker->config->io_size];
    }
  }
  return 0;
}

static int run_stream_tx(int socket_fd, struct worker_result *worker,
                         unsigned char *buffer) {
  uint64_t offset = 0;
  unsigned char acknowledgement = 0;

  worker->start_ns = monotonic_ns();
  while (offset < worker->config->amount) {
    size_t chunk = worker->config->io_size;

    if ((uint64_t)chunk > worker->config->amount - offset)
      chunk = (size_t)(worker->config->amount - offset);
    fill_pattern(buffer, chunk, offset, worker->seed);
    if (send_exact(socket_fd, buffer, chunk, &worker->send_calls) != 0)
      return -1;
    for (size_t index = 0; index < chunk; index++)
      worker->checksum += buffer[index];
    offset += chunk;
  }
  if (recv_exact(socket_fd, &acknowledgement, 1, &worker->recv_calls) != 0)
    return -1;
  if (acknowledgement != READY_BYTE) {
    errno = EPROTO;
    return -1;
  }
  worker->end_ns = monotonic_ns();
  return 0;
}

static int run_stream_rx(int socket_fd, struct worker_result *worker,
                         unsigned char *buffer) {
  uint64_t offset = 0;
  unsigned char acknowledgement = READY_BYTE;

  worker->start_ns = monotonic_ns();
  while (offset < worker->config->amount) {
    size_t chunk = worker->config->io_size;

    if ((uint64_t)chunk > worker->config->amount - offset)
      chunk = (size_t)(worker->config->amount - offset);
    if (recv_exact(socket_fd, buffer, chunk, &worker->recv_calls) != 0)
      return -1;
    if (!verify_pattern(buffer, chunk, offset, worker->seed,
                        &worker->checksum)) {
      errno = EILSEQ;
      return -1;
    }
    offset += chunk;
  }
  if (send_exact(socket_fd, &acknowledgement, 1, &worker->send_calls) != 0)
    return -1;
  worker->end_ns = monotonic_ns();
  return 0;
}

static void *run_worker(void *argument) {
  struct worker_result *worker = argument;
  unsigned char *send_buffer = NULL;
  unsigned char *receive_buffer = NULL;
  int socket_fd = -1;
  int barrier_result;
  unsigned char start = START_BYTE;

  send_buffer = malloc(worker->config->io_size);
  receive_buffer = malloc(worker->config->io_size);
  if (!send_buffer || !receive_buffer) {
    errno = ENOMEM;
    worker_error(worker, "allocate buffers");
    goto done;
  }
  if (is_rr_mode(worker->config->mode)) {
    worker->samples =
        calloc(measured_rr_iterations(worker->config), sizeof(*worker->samples));
    if (!worker->samples) {
      errno = ENOMEM;
      worker_error(worker, "allocate RR samples");
      goto done;
    }
  }
  socket_fd = connect_server(worker);
  if (socket_fd < 0) {
    worker_error(worker, "connect");
    goto done;
  }
  if (exchange_header(socket_fd, worker) != 0) {
    worker_error(worker, "benchmark handshake");
    goto done;
  }
  barrier_result = pthread_barrier_wait(worker->barrier);
  if (barrier_result != 0 && barrier_result != PTHREAD_BARRIER_SERIAL_THREAD) {
    errno = barrier_result;
    worker_error(worker, "pthread_barrier_wait");
    goto done;
  }
  if (send_exact(socket_fd, &start, sizeof(start), NULL) != 0) {
    worker_error(worker, "benchmark start signal");
    goto done;
  }
  if (is_rr_mode(worker->config->mode)) {
    if (run_rr(socket_fd, worker, send_buffer, receive_buffer) != 0)
      worker_error(worker, "TCP_RR exchange");
  } else if (worker->config->mode == MODE_TCP_STREAM_TX) {
    if (run_stream_tx(socket_fd, worker, send_buffer) != 0)
      worker_error(worker, "TCP_STREAM transmit");
  } else if (run_stream_rx(socket_fd, worker, receive_buffer) != 0) {
    worker_error(worker, "TCP_STREAM receive");
  }

done:
  if (socket_fd >= 0)
    close(socket_fd);
  free(send_buffer);
  free(receive_buffer);
  return NULL;
}

static int compare_u64(const void *left, const void *right) {
  uint64_t lhs = *(const uint64_t *)left;
  uint64_t rhs = *(const uint64_t *)right;

  return (lhs > rhs) - (lhs < rhs);
}

static uint64_t percentile(const uint64_t *samples, uint64_t count,
                           uint64_t numerator, uint64_t denominator) {
  uint64_t rank = (count * numerator + denominator - 1) / denominator;

  if (!rank)
    rank = 1;
  return samples[rank - 1];
}

static const char *mode_name(const struct benchmark_config *config) {
  if (config->mode == MODE_TCP_RR)
    return config->ingress ? "ingress-tcp-rr" : "tcp-rr";
  if (config->mode == MODE_TCP_RR_RATE)
    return config->ingress ? "ingress-tcp-rr-rate" : "tcp-rr-rate";
  if (config->mode == MODE_TCP_STREAM_TX)
    return config->ingress ? "ingress-tcp-stream-tx" : "tcp-stream-tx";
  return config->ingress ? "ingress-tcp-stream-rx" : "tcp-stream-rx";
}

static void publish_results(struct benchmark_config *config,
                            struct worker_result *workers) {
  uint64_t earliest = UINT64_MAX;
  uint64_t latest = 0;
  uint64_t send_calls = 0;
  uint64_t recv_calls = 0;
  uint64_t checksum = 0;
  uint64_t late_operations = 0;
  char line[512];

  for (uint32_t index = 0; index < config->connections; index++) {
    if (workers[index].error_number) {
      errno = workers[index].error_number;
      fail(workers[index].error);
    }
    if (workers[index].start_ns < earliest)
      earliest = workers[index].start_ns;
    if (workers[index].end_ns > latest)
      latest = workers[index].end_ns;
    send_calls += workers[index].send_calls;
    recv_calls += workers[index].recv_calls;
    checksum += workers[index].checksum;
    late_operations += workers[index].late_operations;
  }
  if (earliest == UINT64_MAX || latest <= earliest) {
    errno = EDOM;
    fail("benchmark elapsed time");
  }

  if (is_rr_mode(config->mode)) {
    uint64_t iterations = measured_rr_iterations(config);
    uint64_t sample_count = iterations * config->connections;
    uint64_t *samples = malloc(sample_count * sizeof(*samples));
    uint64_t cursor = 0;
    long double rate;

    if (!samples) {
      errno = ENOMEM;
      fail("aggregate RR samples");
    }
    for (uint32_t index = 0; index < config->connections; index++) {
      memcpy(samples + cursor, workers[index].samples,
             iterations * sizeof(*samples));
      cursor += iterations;
    }
    qsort(samples, sample_count, sizeof(*samples), compare_u64);
    rate = (long double)sample_count * 1000000000.0L /
           (long double)(latest - earliest);
    snprintf(line, sizeof(line),
             "MSSOCKBENCH_RESULT mode=%s io_bytes=%u connections=%u "
             "iterations=%" PRIu64 " elapsed_ns=%" PRIu64
             " ops_per_sec=%.3Lf p50_ns=%" PRIu64 " p99_ns=%" PRIu64
             " p999_ns=%" PRIu64 " send_calls=%" PRIu64
             " recv_calls=%" PRIu64 " late_operations=%" PRIu64
             " target_qps=%" PRIu64 " duration_ms=%u checksum=%" PRIu64,
             mode_name(config), config->io_size, config->connections,
             sample_count, latest - earliest, rate,
             percentile(samples, sample_count, 50, 100),
             percentile(samples, sample_count, 99, 100),
             percentile(samples, sample_count, 999, 1000), send_calls,
             recv_calls, late_operations,
             config->mode == MODE_TCP_RR_RATE ? config->amount : 0,
             config->mode == MODE_TCP_RR_RATE ? config->warmup : 0, checksum);
    free(samples);
  } else {
    uint64_t total_bytes = config->amount * config->connections;
    long double rate = (long double)total_bytes * 1000000000.0L /
                       (long double)(latest - earliest) / (1024.0L * 1024.0L);

    snprintf(line, sizeof(line),
             "MSSOCKBENCH_RESULT mode=%s io_bytes=%u connections=%u "
             "total_bytes=%" PRIu64 " elapsed_ns=%" PRIu64
             " mib_per_sec=%.3Lf send_calls=%" PRIu64
             " recv_calls=%" PRIu64 " checksum=%" PRIu64,
             mode_name(config), config->io_size, config->connections,
             total_bytes, latest - earliest, rate, send_calls, recv_calls,
             checksum);
  }
  write_line(line);
}

int main(void) {
  struct benchmark_config config;
  struct worker_result *workers;
  pthread_t *threads;
  pthread_barrier_t barrier;
  int control;

  mount_if_needed("devtmpfs", "/dev", "devtmpfs");
  mount_if_needed("proc", "/proc", "proc");
  mount_if_needed("sysfs", "/sys", "sysfs");
  config = read_config();
  config.listener_fd = prepare_ingress_listener(&config);
  if (config.ingress && config.listener_fd < 0)
    fail("prepare ingress listener");

  control = open(CONTROL_PATH, O_RDWR | O_CLOEXEC);
  if (control < 0)
    fail("open " CONTROL_PATH);
  write_line("MSSOCKBENCH_WARM");
  if (ioctl(control, CHECKPOINT_IOCTL, 0) != 0)
    fail("checkpoint ioctl");
  if (ioctl(control, BENCHMARK_POINT_IOCTL, 0) != 0)
    fail("benchmark-point ioctl");
  write_line("MSSOCKBENCH_RESUMED");

  workers = calloc(config.connections, sizeof(*workers));
  threads = calloc(config.connections, sizeof(*threads));
  if (!workers || !threads) {
    errno = ENOMEM;
    fail("allocate workers");
  }
  if (pthread_barrier_init(&barrier, NULL, config.connections) != 0) {
    errno = EINVAL;
    fail("pthread_barrier_init");
  }
  for (uint32_t index = 0; index < config.connections; index++) {
    workers[index].config = &config;
    workers[index].barrier = &barrier;
    workers[index].seed = index + 1;
    if (pthread_create(&threads[index], NULL, run_worker, &workers[index]) != 0) {
      errno = EAGAIN;
      fail("pthread_create");
    }
  }
  for (uint32_t index = 0; index < config.connections; index++) {
    int result = pthread_join(threads[index], NULL);

    if (result != 0) {
      errno = result;
      fail("pthread_join");
    }
  }
  pthread_barrier_destroy(&barrier);
  publish_results(&config, workers);
  for (uint32_t index = 0; index < config.connections; index++)
    free(workers[index].samples);
  free(workers);
  free(threads);
  close(control);
  if (config.listener_fd >= 0)
    close(config.listener_fd);
  write_line("MSSOCKBENCH_DONE");
  stay_alive();
}
