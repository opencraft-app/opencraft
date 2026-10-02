#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/utsname.h>
#include <time.h>
#include <unistd.h>

int main(int argc, char **argv, char **envp) {
  static const char expected_name[] = "/minisandbox/program";
  static const char default_output[] = "ordinary-static-c\n";
  static const char process_output[] = "args-env-stdin\n";
  if (argv == NULL || argv[0] == NULL || envp == NULL) {
    return 90;
  }

  unsigned char *allocation = malloc(8192);
  if (allocation == NULL) {
    return 91;
  }
  for (size_t index = 0; index < 8192; ++index) {
    allocation[index] = (unsigned char)(index * 17U);
  }
  if (allocation[4097] != (unsigned char)(4097U * 17U)) {
    return 92;
  }
  free(allocation);

  if (argc == 1 && argv[1] == NULL && strcmp(argv[0], expected_name) == 0 &&
      envp[0] == NULL) {
    if (write(STDOUT_FILENO, default_output, sizeof(default_output) - 1) !=
        (ssize_t)(sizeof(default_output) - 1)) {
      return 93;
    }
    return 37;
  }

  if (argc == 2 && argv[2] == NULL && strcmp(argv[1], "mmap") == 0 &&
      envp[0] == NULL) {
    static const char mmap_output[] = "anonymous-mmap\n";
    size_t length = 2U * 1024U * 1024U;
    unsigned char *mapping = mmap(NULL, length, PROT_READ | PROT_WRITE,
                                  MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (mapping == MAP_FAILED) {
      return 96;
    }
    for (size_t offset = 0; offset < length; offset += 4096) {
      mapping[offset] = (unsigned char)(offset >> 12U);
    }
    if (mapping[4096U * 257U] != 1U || munmap(mapping, length) != 0) {
      return 97;
    }
    if (write(STDOUT_FILENO, mmap_output, sizeof(mmap_output) - 1) !=
        (ssize_t)(sizeof(mmap_output) - 1)) {
      return 98;
    }
    return 39;
  }

  if (argc == 2 && argv[2] == NULL &&
      strcmp(argv[1], "readonly-mmap") == 0 && envp[0] == NULL) {
    volatile unsigned char *mapping =
        mmap(NULL, 4096, PROT_READ, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (mapping == MAP_FAILED) {
      return 99;
    }
    mapping[0] = 1;
    return 100;
  }

  if (argc == 2 && argv[2] == NULL &&
      strcmp(argv[1], "munmap-fault") == 0 && envp[0] == NULL) {
    volatile unsigned char *mapping =
        mmap(NULL, 4096, PROT_READ | PROT_WRITE,
             MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (mapping == MAP_FAILED || munmap((void *)mapping, 4096) != 0) {
      return 101;
    }
    return mapping[0];
  }

  if (argc == 2 && argv[2] == NULL &&
      strcmp(argv[1], "mprotect-unmap") == 0 && envp[0] == NULL) {
    static const char protection_output[] = "mprotect-unmap\n";
    void *mapping = mmap(NULL, 4096, PROT_READ | PROT_WRITE,
                         MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (mapping == MAP_FAILED || mprotect(mapping, 4096, PROT_READ) != 0 ||
        munmap(mapping, 4096) != 0) {
      return 104;
    }
    if (write(STDOUT_FILENO, protection_output, sizeof(protection_output) - 1) !=
        (ssize_t)(sizeof(protection_output) - 1)) {
      return 105;
    }
    return 42;
  }

  if (argc == 2 && argv[2] == NULL &&
      strcmp(argv[1], "host-read-isolation") == 0 && envp[0] == NULL) {
    errno = 0;
    if (write(STDOUT_FILENO, (const void *)0x9000, 1) != -1 ||
        errno != EFAULT) {
      return 106;
    }
    return 43;
  }

  if (argc == 2 && argv[2] == NULL &&
      strcmp(argv[1], "host-write-permissions") == 0 && envp[0] == NULL) {
    void *mapping = mmap(NULL, 4096, PROT_READ | PROT_WRITE,
                         MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (mapping == MAP_FAILED || mprotect(mapping, 4096, PROT_READ) != 0) {
      return 107;
    }
    errno = 0;
    if (read(STDIN_FILENO, mapping, 1) != -1 || errno != EFAULT) {
      return 108;
    }
    return 44;
  }

  if (argc == 2 && argv[2] == NULL && strcmp(argv[1], "system") == 0 &&
      envp[0] == NULL) {
    static const char system_output[] = "sandbox-system-info\n";
    struct timespec timestamp;
    struct utsname identity;
    char executable[64];
    ssize_t executable_length =
        readlink("/proc/self/exe", executable, sizeof(executable));
    if (clock_gettime(CLOCK_MONOTONIC, &timestamp) != 0 ||
        timestamp.tv_sec < 0 || timestamp.tv_nsec < 0 ||
        timestamp.tv_nsec >= 1000000000L || getpid() <= 0 ||
        uname(&identity) != 0 || strcmp(identity.sysname, "Linux") != 0 ||
        strcmp(identity.nodename, "minisandbox") != 0 ||
        strcmp(identity.machine, "x86_64") != 0 || executable_length != 20 ||
        memcmp(executable, "/minisandbox/program", 20) != 0) {
      return 102;
    }
    if (write(STDOUT_FILENO, system_output, sizeof(system_output) - 1) !=
        (ssize_t)(sizeof(system_output) - 1)) {
      return 103;
    }
    return 40;
  }

  if (argc != 3 || argv[3] != NULL || strcmp(argv[0], "custom-program") != 0 ||
      strcmp(argv[1], "alpha") != 0 || strcmp(argv[2], "beta") != 0 ||
      envp[0] == NULL || strcmp(envp[0], "MODE=conformance") != 0 ||
      envp[1] != NULL) {
    return 94;
  }
  char input[9];
  if (read(STDIN_FILENO, input, sizeof(input)) != (ssize_t)sizeof(input) ||
      memcmp(input, "input-42\n", sizeof(input)) != 0) {
    return 95;
  }
  if (write(STDOUT_FILENO, process_output, sizeof(process_output) - 1) !=
      (ssize_t)(sizeof(process_output) - 1)) {
    return 93;
  }
  return 38;
}
