#include "minisandbox.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum {
  ELF_HEADER_SIZE = 64,
  PROGRAM_HEADER_SIZE = 56,
  FILE_OFFSET = 0x1000,
};

static const uint64_t VIRTUAL_ADDRESS = UINT64_C(0x100000);
static const uint8_t GUEST_CODE[] = {
    0xb8, 1,    0,    0,    0,          /* mov eax, 1 */
    0xbf, 1,    0,    0,    0,          /* mov edi, 1 */
    0x48, 0xbe, 0x29, 0x00, 0x10, 0x00, /* mov rsi, 0x100029 */
    0x00, 0x00, 0x00, 0x00,
    0xba, 12,   0,    0,    0,          /* mov edx, 12 */
    0x0f, 0x05,                         /* syscall */
    0xb8, 60,   0,    0,    0,          /* mov eax, 60 */
    0xbf, 73,   0,    0,    0,          /* mov edi, 73 */
    0x0f, 0x05, 0x0f, 0x0b,             /* syscall; ud2 */
    'm',  'i',  'n',  'i',  's',  'a',
    'n',  'd',  'b',  'o',  'x',  '\n',
};

struct output_buffer {
  uint8_t bytes[64];
  size_t length;
};

static void put_u16(uint8_t *destination, uint16_t value) {
  memcpy(destination, &value, sizeof(value));
}

static void put_u32(uint8_t *destination, uint32_t value) {
  memcpy(destination, &value, sizeof(value));
}

static void put_u64(uint8_t *destination, uint64_t value) {
  memcpy(destination, &value, sizeof(value));
}

static uint8_t *make_elf(size_t *length) {
  *length = FILE_OFFSET + sizeof(GUEST_CODE);
  uint8_t *elf = calloc(*length, 1);
  if (elf == NULL) {
    return NULL;
  }
  const uint8_t identity[16] = {0x7f, 'E', 'L', 'F', 2, 1, 1};
  memcpy(elf, identity, sizeof(identity));
  put_u16(elf + 16, 2);
  put_u16(elf + 18, 62);
  put_u32(elf + 20, 1);
  put_u64(elf + 24, VIRTUAL_ADDRESS);
  put_u64(elf + 32, ELF_HEADER_SIZE);
  put_u16(elf + 52, ELF_HEADER_SIZE);
  put_u16(elf + 54, PROGRAM_HEADER_SIZE);
  put_u16(elf + 56, 1);
  put_u32(elf + ELF_HEADER_SIZE, 1);
  put_u32(elf + ELF_HEADER_SIZE + 4, 5);
  put_u64(elf + ELF_HEADER_SIZE + 8, FILE_OFFSET);
  put_u64(elf + ELF_HEADER_SIZE + 16, VIRTUAL_ADDRESS);
  put_u64(elf + ELF_HEADER_SIZE + 24, VIRTUAL_ADDRESS);
  put_u64(elf + ELF_HEADER_SIZE + 32, sizeof(GUEST_CODE));
  put_u64(elf + ELF_HEADER_SIZE + 40, sizeof(GUEST_CODE));
  put_u64(elf + ELF_HEADER_SIZE + 48, 0x1000);
  memcpy(elf + FILE_OFFSET, GUEST_CODE, sizeof(GUEST_CODE));
  return elf;
}

static MinisandboxStatus capture_output(void *context, const uint8_t *bytes,
                                        size_t length) {
  struct output_buffer *output = context;
  if (bytes == NULL || length > sizeof(output->bytes) - output->length) {
    return MINISANDBOX_STATUS_INVALID_ARGUMENT;
  }
  memcpy(output->bytes + output->length, bytes, length);
  output->length += length;
  return MINISANDBOX_STATUS_OK;
}

static int require_ok(MinisandboxStatus status, const char *operation) {
  if (status == MINISANDBOX_STATUS_OK) {
    return 1;
  }
  fprintf(stderr, "%s failed (%u): %s\n", operation, (unsigned)status,
          minisandbox_last_error());
  return 0;
}

int main(void) {
  const uint32_t expected_abi_version =
      ((uint32_t)MINISANDBOX_ABI_VERSION_MAJOR << 16) |
      (uint32_t)MINISANDBOX_ABI_VERSION_MINOR;
  if (minisandbox_abi_version() != expected_abi_version) {
    fputs("unexpected minisandbox ABI version\n", stderr);
    return 1;
  }
  MinisandboxRuntimeOptions runtime_options = {
      .struct_size = sizeof(MinisandboxRuntimeOptions),
      .abi_version = minisandbox_abi_version(),
      .max_memory = UINT64_C(64) * 1024 * 1024,
      .vcpu_count = 1,
      .flags = 0,
  };
  MinisandboxRunOptions run_options = {
      .struct_size = sizeof(MinisandboxRunOptions),
      .abi_version = minisandbox_abi_version(),
      .timeout_ns = UINT64_C(1000000000),
  };
  MinisandboxHandle runtime = 0;
  MinisandboxHandle program = 0;
  MinisandboxHandle instance = 0;
  size_t elf_length = 0;
  uint8_t *elf = make_elf(&elf_length);
  struct output_buffer output = {{0}, 0};
  int32_t exit_code = 0;
  int success = elf != NULL;

  success = success && require_ok(
                           minisandbox_runtime_create(&runtime_options, &runtime),
                           "runtime_create");
  success = success &&
            require_ok(minisandbox_program_load(runtime, elf, elf_length, &program),
                       "program_load");
  success = success &&
            require_ok(minisandbox_instance_create(runtime, program, &instance),
                       "instance_create");
  success = success &&
            require_ok(minisandbox_instance_run(instance, &run_options, capture_output,
                                                &output),
                       "instance_run");
  success = success &&
            require_ok(minisandbox_instance_exit_code(instance, &exit_code),
                       "instance_exit_code");
  success = success && output.length == 12 &&
            memcmp(output.bytes, "minisandbox\n", 12) == 0 && exit_code == 73;

  if (instance != 0) {
    success = require_ok(minisandbox_release(instance), "release instance") && success;
  }
  if (program != 0) {
    success = require_ok(minisandbox_release(program), "release program") && success;
  }
  if (runtime != 0) {
    success = require_ok(minisandbox_release(runtime), "release runtime") && success;
  }
  free(elf);
  if (!success) {
    fputs("C ABI smoke failed\n", stderr);
    return 1;
  }
  puts("C ABI smoke passed: output=minisandbox exit=73");
  return 0;
}
