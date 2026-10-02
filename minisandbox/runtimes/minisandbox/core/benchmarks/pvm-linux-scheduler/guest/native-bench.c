// SPDX-License-Identifier: MIT OR Apache-2.0

#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <linux/futex.h>
#include <math.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define SAMPLE_COUNT 1000
#define WARMUP_COUNT 50
#define TOTAL_SAMPLES (SAMPLE_COUNT + WARMUP_COUNT)
#define FAIR_CHILDREN 4
#define NS_PER_MS 1000000ULL
#define TIMER_STORM_DELAY_NS 10000ULL

static void fail(const char *operation) {
  fprintf(stderr, "MSBENCH_FAIL %s: %s\n", operation, strerror(errno));
  exit(1);
}

static uint64_t monotonic_ns(void) {
  struct timespec value;
  if (clock_gettime(CLOCK_MONOTONIC, &value) != 0)
    fail("clock_gettime");
  return (uint64_t)value.tv_sec * 1000000000ULL + (uint64_t)value.tv_nsec;
}

static struct timespec ns_to_timespec(uint64_t value) {
  return (struct timespec){.tv_sec = (time_t)(value / 1000000000ULL),
                           .tv_nsec = (long)(value % 1000000000ULL)};
}

static void sleep_until(uint64_t deadline) {
  struct timespec value = ns_to_timespec(deadline);
  int result;
  do {
    result = clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &value, NULL);
  } while (result == EINTR);
  if (result != 0) {
    errno = result;
    fail("clock_nanosleep");
  }
}

static void read_exact(int descriptor, void *buffer, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t result = read(descriptor, (char *)buffer + offset, length - offset);
    if (result < 0 && errno == EINTR)
      continue;
    if (result <= 0)
      fail("read");
    offset += (size_t)result;
  }
}

static void write_exact(int descriptor, const void *buffer, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t result =
        write(descriptor, (const char *)buffer + offset, length - offset);
    if (result < 0 && errno == EINTR)
      continue;
    if (result <= 0)
      fail("write");
    offset += (size_t)result;
  }
}

static int futex_wait(_Atomic int *address, int expected) {
  return (int)syscall(SYS_futex, address, FUTEX_WAIT_PRIVATE, expected, NULL,
                      NULL, 0);
}

static void futex_wake(_Atomic int *address) {
  if (syscall(SYS_futex, address, FUTEX_WAKE_PRIVATE, 1, NULL, NULL, 0) < 0)
    fail("futex wake");
}

static void wait_for_value(_Atomic int *address, int expected) {
  while (atomic_load_explicit(address, memory_order_acquire) < expected) {
    int observed = atomic_load_explicit(address, memory_order_relaxed);
    if (futex_wait(address, observed) != 0 && errno != EAGAIN && errno != EINTR)
      fail("futex wait");
  }
}

struct futex_state {
  _Atomic int ready;
  _Atomic int word;
  _Atomic int done;
  uint64_t sent;
  uint64_t samples[TOTAL_SAMPLES];
};

static void *futex_reader(void *opaque) {
  struct futex_state *state = opaque;
  for (int index = 0; index < TOTAL_SAMPLES; ++index) {
    atomic_store_explicit(&state->ready, index + 1, memory_order_release);
    futex_wake(&state->ready);
    wait_for_value(&state->word, 1);
    state->samples[index] = monotonic_ns() - state->sent;
    atomic_store_explicit(&state->word, 0, memory_order_release);
    atomic_store_explicit(&state->done, index + 1, memory_order_release);
    futex_wake(&state->done);
  }
  return NULL;
}

static void measure_futex(uint64_t samples[TOTAL_SAMPLES]) {
  struct futex_state state = {0};
  pthread_t reader;
  if (pthread_create(&reader, NULL, futex_reader, &state) != 0)
    fail("pthread_create futex");
  for (int index = 0; index < TOTAL_SAMPLES; ++index) {
    wait_for_value(&state.ready, index + 1);
    state.sent = monotonic_ns();
    atomic_store_explicit(&state.word, 1, memory_order_release);
    futex_wake(&state.word);
    wait_for_value(&state.done, index + 1);
  }
  if (pthread_join(reader, NULL) != 0)
    fail("pthread_join futex");
  memcpy(samples, state.samples, sizeof(state.samples));
}

struct pipe_state {
  int input;
  int acknowledgement;
  uint64_t samples[TOTAL_SAMPLES];
};

static void *pipe_reader(void *opaque) {
  struct pipe_state *state = opaque;
  for (int index = 0; index < TOTAL_SAMPLES; ++index) {
    uint64_t sent;
    char acknowledgement = 1;
    read_exact(state->input, &sent, sizeof(sent));
    state->samples[index] = monotonic_ns() - sent;
    write_exact(state->acknowledgement, &acknowledgement,
                sizeof(acknowledgement));
  }
  return NULL;
}

static void measure_pipe(uint64_t samples[TOTAL_SAMPLES]) {
  int payload[2];
  int acknowledgement[2];
  if (pipe2(payload, O_CLOEXEC) != 0 || pipe2(acknowledgement, O_CLOEXEC) != 0)
    fail("pipe2");
  struct pipe_state state = {.input = payload[0],
                             .acknowledgement = acknowledgement[1]};
  pthread_t reader;
  if (pthread_create(&reader, NULL, pipe_reader, &state) != 0)
    fail("pthread_create pipe");
  for (int index = 0; index < TOTAL_SAMPLES; ++index) {
    uint64_t sent = monotonic_ns();
    char received;
    write_exact(payload[1], &sent, sizeof(sent));
    read_exact(acknowledgement[0], &received, sizeof(received));
  }
  if (pthread_join(reader, NULL) != 0)
    fail("pthread_join pipe");
  memcpy(samples, state.samples, sizeof(state.samples));
  close(payload[0]);
  close(payload[1]);
  close(acknowledgement[0]);
  close(acknowledgement[1]);
}

static void measure_timer(uint64_t samples[TOTAL_SAMPLES]) {
  for (int index = 0; index < TOTAL_SAMPLES; ++index) {
    uint64_t deadline = monotonic_ns() + NS_PER_MS;
    sleep_until(deadline);
    samples[index] = monotonic_ns() - deadline;
  }
}

static int compare_u64(const void *left, const void *right) {
  uint64_t lhs = *(const uint64_t *)left;
  uint64_t rhs = *(const uint64_t *)right;
  return (lhs > rhs) - (lhs < rhs);
}

struct quantiles {
  uint64_t p50;
  uint64_t p99;
  uint64_t p999;
  uint64_t maximum;
};

static struct quantiles quantiles(uint64_t values[TOTAL_SAMPLES]) {
  uint64_t sorted[SAMPLE_COUNT];
  memcpy(sorted, values + WARMUP_COUNT, sizeof(sorted));
  qsort(sorted, SAMPLE_COUNT, sizeof(sorted[0]), compare_u64);
  return (struct quantiles){.p50 = sorted[(SAMPLE_COUNT * 50 - 1) / 100],
                            .p99 = sorted[(SAMPLE_COUNT * 99 - 1) / 100],
                            .p999 = sorted[(SAMPLE_COUNT * 999 - 1) / 1000],
                            .maximum = sorted[SAMPLE_COUNT - 1]};
}

static int benchmark_wakeup(void) {
  uint64_t futex_samples[TOTAL_SAMPLES];
  uint64_t pipe_samples[TOTAL_SAMPLES];
  uint64_t timer_samples[TOTAL_SAMPLES];
  measure_futex(futex_samples);
  measure_pipe(pipe_samples);
  measure_timer(timer_samples);
  struct quantiles futex = quantiles(futex_samples);
  struct quantiles pipe_result = quantiles(pipe_samples);
  struct quantiles timer = quantiles(timer_samples);
  printf("MSBENCH_RESULT mode=wakeup samples=%d "
         "futex_p50_ns=%llu futex_p99_ns=%llu futex_p999_ns=%llu "
         "futex_max_ns=%llu pipe_p50_ns=%llu pipe_p99_ns=%llu "
         "pipe_p999_ns=%llu pipe_max_ns=%llu timer_p50_ns=%llu "
         "timer_p99_ns=%llu timer_p999_ns=%llu timer_max_ns=%llu\n",
         SAMPLE_COUNT, (unsigned long long)futex.p50,
         (unsigned long long)futex.p99, (unsigned long long)futex.p999,
         (unsigned long long)futex.maximum, (unsigned long long)pipe_result.p50,
         (unsigned long long)pipe_result.p99,
         (unsigned long long)pipe_result.p999,
         (unsigned long long)pipe_result.maximum, (unsigned long long)timer.p50,
         (unsigned long long)timer.p99, (unsigned long long)timer.p999,
         (unsigned long long)timer.maximum);
  return 0;
}

struct fairness_result {
  uint32_t child;
  uint32_t checksum;
  uint64_t operations;
};

static int benchmark_fairness(uint64_t duration_ms) {
  int results[2];
  if (pipe2(results, O_CLOEXEC) != 0)
    fail("fairness pipe");
  uint64_t start = monotonic_ns() + 50 * NS_PER_MS;
  uint64_t deadline = start + duration_ms * NS_PER_MS;
  for (uint32_t child = 0; child < FAIR_CHILDREN; ++child) {
    pid_t process = fork();
    if (process < 0)
      fail("fairness fork");
    if (process == 0) {
      close(results[0]);
      sleep_until(start);
      uint32_t value = 0x12345678U ^ child;
      uint64_t operations = 0;
      while (monotonic_ns() < deadline) {
        for (int index = 0; index < 4096; ++index)
          value = value * 1664525U + 1013904223U;
        operations += 4096;
      }
      struct fairness_result result = {
          .child = child, .checksum = value, .operations = operations};
      write_exact(results[1], &result, sizeof(result));
      _exit(0);
    }
  }
  close(results[1]);
  uint64_t counts[FAIR_CHILDREN] = {0};
  uint64_t checksum = 0;
  for (int index = 0; index < FAIR_CHILDREN; ++index) {
    struct fairness_result result;
    read_exact(results[0], &result, sizeof(result));
    if (result.child >= FAIR_CHILDREN) {
      errno = EINVAL;
      fail("fairness child index");
    }
    counts[result.child] = result.operations;
    checksum += result.checksum;
  }
  close(results[0]);
  for (int index = 0; index < FAIR_CHILDREN; ++index) {
    int status;
    if (wait(&status) < 0 || !WIFEXITED(status) || WEXITSTATUS(status) != 0)
      fail("fairness wait");
  }
  uint64_t minimum = counts[0];
  uint64_t maximum = counts[0];
  long double sum = 0;
  long double squares = 0;
  for (int index = 0; index < FAIR_CHILDREN; ++index) {
    if (counts[index] < minimum)
      minimum = counts[index];
    if (counts[index] > maximum)
      maximum = counts[index];
    sum += (long double)counts[index];
    squares += (long double)counts[index] * (long double)counts[index];
  }
  unsigned long long jain_ppm =
      (unsigned long long)((sum * sum * 1000000.0L) /
                           ((long double)FAIR_CHILDREN * squares));
  printf("MSBENCH_RESULT mode=fairness children=%d duration_ms=%llu "
         "ops0=%llu ops1=%llu ops2=%llu ops3=%llu min_ops=%llu "
         "max_ops=%llu jain_ppm=%llu checksum=%llu\n",
         FAIR_CHILDREN, (unsigned long long)duration_ms,
         (unsigned long long)counts[0], (unsigned long long)counts[1],
         (unsigned long long)counts[2], (unsigned long long)counts[3],
         (unsigned long long)minimum, (unsigned long long)maximum, jain_ppm,
         (unsigned long long)checksum);
  return 0;
}

static int benchmark_exits(uint64_t count) {
  int control = open("/dev/minisandbox", O_RDWR | O_CLOEXEC);
  if (control < 0)
    fail("open minisandbox");
  uint64_t started = monotonic_ns();
  for (uint64_t index = 0; index < count; ++index) {
    if (ioctl(control, _IO(0xb7, 2)) != 0)
      fail("benchmark ioctl");
  }
  uint64_t elapsed = monotonic_ns() - started;
  close(control);
  printf("MSBENCH_RESULT mode=exit exits=%llu elapsed_ns=%llu ns_per_exit=%llu\n",
         (unsigned long long)count, (unsigned long long)elapsed,
         (unsigned long long)(elapsed / count));
  return 0;
}

static int benchmark_timer_storm(uint64_t duration_ms) {
  uint64_t started = monotonic_ns();
  uint64_t deadline = started + duration_ms * NS_PER_MS;
  uint64_t timers = 0;

  while (monotonic_ns() < deadline) {
    sleep_until(monotonic_ns() + TIMER_STORM_DELAY_NS);
    timers++;
  }
  uint64_t elapsed = monotonic_ns() - started;
  if (timers == 0) {
    errno = EDOM;
    fail("timer storm made no progress");
  }
  printf("MSBENCH_RESULT mode=timer-storm timers=%llu elapsed_ns=%llu "
         "ns_per_timer=%llu\n",
         (unsigned long long)timers, (unsigned long long)elapsed,
         (unsigned long long)(elapsed / timers));
  return 0;
}

static uint64_t parse_positive(const char *text) {
  char *end = NULL;
  errno = 0;
  unsigned long long value = strtoull(text, &end, 10);
  if (errno != 0 || end == text || *end != '\0' || value == 0) {
    errno = EINVAL;
    fail("parse positive argument");
  }
  return (uint64_t)value;
}

int main(int argument_count, char **arguments) {
  if (argument_count == 2 && strcmp(arguments[1], "wakeup") == 0)
    return benchmark_wakeup();
  if (argument_count == 3 && strcmp(arguments[1], "fairness") == 0)
    return benchmark_fairness(parse_positive(arguments[2]));
  if (argument_count == 3 && strcmp(arguments[1], "exit") == 0)
    return benchmark_exits(parse_positive(arguments[2]));
  if (argument_count == 3 && strcmp(arguments[1], "timer-storm") == 0)
    return benchmark_timer_storm(parse_positive(arguments[2]));
  fprintf(stderr,
          "usage: native-bench <wakeup|fairness milliseconds|exit count|"
          "timer-storm milliseconds>\n");
  return 2;
}
