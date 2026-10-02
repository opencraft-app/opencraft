#define _GNU_SOURCE

#include <stdint.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

#include "quickjs.h"

enum {
  MINISANDBOX_SYS_BOOTSTRAP = 0x7f00,
  MINISANDBOX_SYS_CHECKPOINT = 0x7f01,
  MAILBOX_CAPACITY = 64 * 1024,
  QUICKJS_MEMORY_LIMIT = 24 * 1024 * 1024,
  QUICKJS_STACK_LIMIT = 512 * 1024,
};

static char mailbox[MAILBOX_CAPACITY] __attribute__((aligned(4096)));

static void write_stdout(const char *bytes, size_t length) {
  (void)syscall(SYS_write, STDOUT_FILENO, bytes, length);
}

static int report_exception(JSContext *context) {
  JSValue exception = JS_GetException(context);
  const char *text = JS_ToCString(context, exception);
  if (text != NULL) {
    write_stdout(text, strlen(text));
    write_stdout("\n", 1);
    JS_FreeCString(context, text);
  }
  JS_FreeValue(context, exception);
  return 70;
}

static int evaluate(JSContext *context, const char *source, size_t length,
                    const char *name) {
  JSValue value = JS_Eval(context, source, length, name, JS_EVAL_TYPE_GLOBAL);
  if (JS_IsException(value)) {
    return report_exception(context);
  }
  JS_FreeValue(context, value);
  return 0;
}

int main(void) {
  static const char wrapper[] =
      "globalThis.__minisandboxTurn=(text)=>"
      "JSON.stringify(globalThis.handle(JSON.parse(text)));";
  JSRuntime *runtime = JS_NewRuntime();
  if (runtime == NULL) {
    return 71;
  }
  JS_SetMemoryLimit(runtime, QUICKJS_MEMORY_LIMIT);
  JS_SetMaxStackSize(runtime, QUICKJS_STACK_LIMIT);
  JSContext *context = JS_NewContext(runtime);
  if (context == NULL) {
    return 72;
  }

  long deployment_length =
      syscall(MINISANDBOX_SYS_BOOTSTRAP, mailbox, sizeof(mailbox));
  if (deployment_length < 0 ||
      (unsigned long)deployment_length > sizeof(mailbox)) {
    return 73;
  }
  int status = evaluate(context, mailbox, (size_t)deployment_length,
                        "minisandbox:deployment");
  if (status != 0) {
    return status;
  }
  status = evaluate(context, wrapper, sizeof(wrapper) - 1,
                    "minisandbox:turn-wrapper");
  if (status != 0) {
    return status;
  }

  long input_length =
      syscall(MINISANDBOX_SYS_CHECKPOINT, mailbox, sizeof(mailbox));
  if (input_length < 0 || (unsigned long)input_length > sizeof(mailbox)) {
    return 74;
  }

  JSValue global = JS_GetGlobalObject(context);
  JSValue function = JS_GetPropertyStr(context, global, "__minisandboxTurn");
  JSValue argument = JS_NewStringLen(context, mailbox, (size_t)input_length);
  JSValue result = JS_Call(context, function, global, 1, &argument);
  JS_FreeValue(context, argument);
  JS_FreeValue(context, function);
  JS_FreeValue(context, global);
  if (JS_IsException(result)) {
    return report_exception(context);
  }
  const char *output = JS_ToCString(context, result);
  if (output == NULL) {
    JS_FreeValue(context, result);
    return report_exception(context);
  }
  write_stdout(output, strlen(output));
  JS_FreeCString(context, output);
  JS_FreeValue(context, result);
  return 0;
}
