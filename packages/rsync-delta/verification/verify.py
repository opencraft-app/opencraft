#!/usr/bin/env python3
"""SMT invariants plus exhaustive finite checking of an abstract rsync engine.

This verifies the mathematical algorithm, not TypeScript/compiler correctness or
SHA-256 collision resistance. The finite model uses exact bytes as a strong hash.
Real implementation conformance, malformed inputs and async ownership are tested
separately in test/rsync-delta.test.ts. See README.md for assumptions and bounds.
"""
import argparse
import itertools
import json
from pathlib import Path
import time
import z3


def prove(name, variables, violation, results, output):
    solver = z3.Solver()
    solver.set(timeout=30_000)
    solver.add(*variables, violation)
    if output:
        (output / (name + ".smt2")).write_text(solver.to_smt2())
    status = solver.check()
    if status != z3.unsat:
        raise AssertionError(f"{name}: {status}; counterexample={solver.model() if status == z3.sat else solver.reason_unknown()}")
    results[name] = "unsat"


def smt(results, output):
    # Arbitrary-length windows: n is the window length modulo 2^16. Tail
    # aggregates are defined by sum(x_i) and sum((n-i)*x_i), i=1..n-1.
    # Every concrete window instantiates these aggregates. No enumeration of n
    # is needed; BitVec arithmetic supplies precisely the specified modulo.
    n, outgoing, incoming, tail_sum, tail_weight = z3.BitVecs("n outgoing incoming tail_sum tail_weight", 16)
    old_a, old_b = outgoing + tail_sum, n * outgoing + tail_weight
    rolled_a = old_a - outgoing + incoming
    rolled_b = old_b - n * outgoing + rolled_a
    prove("rolling_recurrence", [], z3.Or(rolled_a != tail_sum + incoming,
          rolled_b != tail_weight + tail_sum + incoming), results, output)

    position, length, offset, basis_size, target_size, k = z3.Ints("position length offset basis_size target_size k")
    bounds = [position >= 0, length > 0, offset >= 0, basis_size >= 0,
              target_size >= 0, offset <= basis_size, length <= basis_size - offset,
              position <= target_size, length <= target_size - position, k >= 0, k < length]
    prove("copy_bounds", bounds, z3.Or(offset + k < 0, offset + k >= basis_size,
          position + k < 0, position + k >= target_size), results, output)

    start, requested, window, total = z3.Ints("start requested window total")
    prove("rolling_window_bounds", [window > 0, start >= 0, start < requested,
          requested <= total - window], z3.Or(start >= total, start + window < 0,
          start + window >= total), results, output)

    first, second, left, right, size, t = z3.Ints("first second left right size t")
    prove("copy_coalescing", [first >= 0, left > 0, right > 0, second == first + left,
          second <= size, right <= size - second, t >= 0, t < left + right],
          z3.Or(z3.If(t < left, first + t, second + t - left) != first + t,
                left + right > size - first), results, output)

    # Inductive COPY/LITERAL Hoare step. The known prefix equals the target;
    # the operation's bytes equal its next segment. Under that precondition the
    # new prefix still equals the target. A collision-free strong match supplies
    # the COPY premise; LITERAL bytes come directly from the target snapshot.
    j = z3.Int("j")
    before, target, basis, literal = [z3.Array(name, z3.IntSort(), z3.BitVecSort(8))
                                    for name in ["before", "target", "basis", "literal"]]
    copy = z3.Bool("copy")
    segment = z3.If(copy, basis[offset + j - position], literal[j - position])
    after = z3.If(j < position, before[j], segment)
    premises = [position >= 0, length > 0, j >= 0, j < position + length,
                z3.Implies(j < position, before[j] == target[j]),
                z3.Implies(j >= position, segment == target[j])]
    prove("prefix_preservation", premises, after != target[j], results, output)

    step = z3.Int("step")
    prove("greedy_termination", [position >= 0, position < target_size,
          step >= 1, step <= target_size - position],
          z3.Or(target_size - (position + step) < 0,
                target_size - (position + step) >= target_size - position), results, output)


def weak(value):
    return (sum(value) % 65536) | ((sum((len(value) - i) * x for i, x in enumerate(value)) % 65536) << 16)


def model(basis, target, size, collide):
    checksum = (lambda _: 0) if collide else weak
    index = {}
    for offset in range(0, len(basis), size):
        block = basis[offset:offset + size]
        index.setdefault(len(block), {}).setdefault(checksum(block), {}).setdefault(block, offset)
    position, literal_start, steps, collisions = 0, 0, 0, 0
    operations = []
    while position < len(target):
        previous = position
        match = None
        for length in sorted(index, reverse=True):
            block = target[position:position + length]
            if len(block) != length:
                continue
            candidates = index[length].get(checksum(block), {})
            if candidates and block not in candidates:
                collisions += 1
            if block in candidates:
                match = (candidates[block], length)
                break
        if match:
            if literal_start < position:
                operations.append(("literal", target[literal_start:position]))
            operations.append(("copy", match))
            position += match[1]
            literal_start = position
        else:
            position += 1
        assert previous < position <= len(target)
        steps += 1
        assert steps <= len(target)
    if literal_start < position:
        operations.append(("literal", target[literal_start:position]))
    output = b""
    for kind, value in operations:
        if kind == "copy":
            offset, length = value
            assert 0 <= offset and 0 < length <= len(basis) - offset
            block = basis[offset:offset + length]
        else:
            block = value
        assert block and len(block) <= len(target) - len(output)
        output += block
        assert output == target[:len(output)]
    assert output == target
    return collisions


def finite(max_length):
    values = [bytes(v) for n in range(max_length + 1) for v in itertools.product(range(3), repeat=n)]
    cases, collisions, forced = 0, 0, 0
    for basis in values:
        for target in values:
            for size in range(1, 5):
                collisions += model(basis, target, size, False)
                forced += model(basis, target, size, True)
                cases += 2
    assert collisions > 0 if max_length >= 3 else True
    return {"cases": cases, "alphabet": [0, 1, 2], "max_length": max_length,
            "block_sizes": [1, 2, 3, 4], "weak_modes": ["real", "constant-collision"],
            "real_weak_collision_checks": collisions, "forced_collision_checks": forced}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--max-length", type=int, default=4)
    args = parser.parse_args()
    if args.max_length < 0:
        parser.error("max-length must be nonnegative")
    if args.output:
        args.output.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    proofs = {}
    smt(proofs, args.output)
    print(json.dumps({"phase": "smt", "proofs": proofs}), flush=True)
    report = {"solver": "Z3 " + z3.get_version_string(), "proofs": proofs,
              "finite_model": finite(args.max_length), "elapsed_seconds": time.monotonic() - started,
              "assumptions": ["COPY strong hashes are collision-free in the abstract model",
                              "the source and authorization-view boundary is supplied by the caller",
                              "SMT proves the mathematical model, not the TypeScript runtime/compiler"]}
    if args.output:
        (args.output / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
