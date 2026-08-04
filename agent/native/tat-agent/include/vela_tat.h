#ifndef VELA_TAT_H
#define VELA_TAT_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct VelaTatHandle VelaTatHandle;

int vela_tat_register(
    const char *state_root,
    const char *region,
    const char *register_code_id,
    const char *register_code_value,
    const char *tags_json);

int vela_tat_start(
    const char *state_root,
    VelaTatHandle **out_handle);

int vela_tat_close(VelaTatHandle *handle);

size_t vela_tat_last_error(
    char *destination,
    size_t capacity);

#ifdef __cplusplus
}
#endif

#endif
