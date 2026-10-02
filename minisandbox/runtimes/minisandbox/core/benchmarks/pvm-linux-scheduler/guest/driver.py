# SPDX-License-Identifier: MIT OR Apache-2.0

import fcntl
import hashlib
import os
import subprocess
import time


CHECKPOINT_IOCTL = 0xB701
BENCHMARK_POINT_IOCTL = 0xB702
CONTROL_PATH = "/dev/minisandbox"


def command_line_value(name: str, default: str) -> str:
    prefix = f"msbench.{name}="
    with open("/proc/cmdline", "r", encoding="ascii") as command_line:
        for field in command_line.read().split():
            if field.startswith(prefix):
                return field[len(prefix) :]
    return default


def write_line(line: str) -> None:
    payload = f"{line}\n".encode()
    if os.write(1, payload) != len(payload):
        raise RuntimeError("short benchmark console write")


def cpu_python(duration_ns: int) -> None:
    value = 0x12345678
    operations = 0
    started = time.monotonic_ns()
    deadline = started + duration_ns
    while time.monotonic_ns() < deadline:
        for _ in range(4096):
            value = (value * 1664525 + 1013904223) & 0xFFFFFFFF
        operations += 4096
    write_line(
        f"MSBENCH_RESULT mode=cpu-python ops={operations} "
        f"elapsed_ns={time.monotonic_ns() - started} checksum={value}"
    )


def cpu_sha256(duration_ns: int) -> None:
    payload = bytes([0xA5]) * 65536
    bytes_hashed = 0
    digest = b""
    started = time.monotonic_ns()
    deadline = started + duration_ns
    while time.monotonic_ns() < deadline:
        digest = hashlib.sha256(payload).digest()
        bytes_hashed += len(payload)
    write_line(
        f"MSBENCH_RESULT mode=cpu-sha256 bytes={bytes_hashed} "
        f"elapsed_ns={time.monotonic_ns() - started} checksum={digest[:8].hex()}"
    )


def run_child(arguments: list[str]) -> None:
    result = subprocess.run(arguments, check=True, stdout=subprocess.PIPE)
    payload = result.stdout
    if not payload.endswith(b"\n"):
        raise RuntimeError("benchmark child omitted final newline")
    if os.write(1, payload) != len(payload):
        raise RuntimeError("short child benchmark console write")


def interrupt_counts() -> tuple[int, int]:
    total = 0
    timer = 0
    with open("/proc/interrupts", "r", encoding="ascii") as interrupts:
        for line in interrupts:
            if ":" not in line:
                continue
            _, values = line.split(":", 1)
            fields = values.split()
            counts = []
            for field in fields:
                if not field.isdecimal():
                    break
                counts.append(int(field))
            line_total = sum(counts)
            total += line_total
            lowered = line.lower()
            if "timer" in lowered or "lapic" in lowered or "pit" in lowered:
                timer += line_total
    return total, timer


mode = command_line_value("mode", "cpu-python")
amount = int(command_line_value("amount", "1000"))
duration_ns = amount * 1_000_000

# Resolve and fault the workload dependencies before publishing the template.
if mode == "cpu-v8":
    subprocess.run(["/usr/bin/node", "--version"], check=True, stdout=subprocess.DEVNULL)
elif mode in {"wakeup", "fairness", "exit", "timer-storm"}:
    os.stat("/opt/msbench/native-bench")

control = os.open(CONTROL_PATH, os.O_RDWR | os.O_CLOEXEC)
write_line(f"MSBENCH_WARM mode={mode}")
fcntl.ioctl(control, CHECKPOINT_IOCTL, 0)
fcntl.ioctl(control, BENCHMARK_POINT_IOCTL, 0)
write_line(f"MSBENCH_RESUMED mode={mode}")

if mode == "cpu-python":
    cpu_python(duration_ns)
elif mode == "cpu-sha256":
    cpu_sha256(duration_ns)
elif mode == "cpu-v8":
    run_child(["/usr/bin/node", "/opt/msbench/v8-loop.js", str(duration_ns)])
elif mode == "wakeup":
    run_child(["/opt/msbench/native-bench", "wakeup"])
elif mode == "fairness":
    run_child(["/opt/msbench/native-bench", "fairness", str(amount)])
elif mode == "exit":
    run_child(["/opt/msbench/native-bench", "exit", str(amount)])
elif mode == "timer-storm":
    run_child(["/opt/msbench/native-bench", "timer-storm", str(amount)])
elif mode == "idle":
    # The minimal guest changes from the boot clocksource to TSC roughly one
    # second after boot. Keep its one-time serial log and UART register polling
    # outside the synchronized steady-state interval.
    time.sleep(1.0)
    interrupts_before, timers_before = interrupt_counts()
    write_line("MSBENCH_IDLE_READY")
    started = time.monotonic_ns()
    time.sleep((amount + 250) / 1000)
    elapsed = time.monotonic_ns() - started
    interrupts_after, timers_after = interrupt_counts()
    write_line(
        f"MSBENCH_RESULT mode=idle elapsed_ns={elapsed} "
        f"interrupts={interrupts_after - interrupts_before} "
        f"timer_interrupts={timers_after - timers_before}"
    )
else:
    raise RuntimeError(f"unknown benchmark mode: {mode}")

write_line("MSBENCH_DONE")
while True:
    time.sleep(3600)
