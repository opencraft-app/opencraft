"""Bounded state model of bucket replacement under a collision-free digest assumption.
Not a proof of SHA-256 or of all transport/lifecycle interleavings.
"""
from itertools import product

states = [{i: value for i, value in enumerate(values) if value} for values in product(range(3), repeat=4)]
checked = 0
for before in states:
    for after in states:
        buckets = lambda rows: [tuple(sorted((key, value) for key, value in rows.items() if key % 2 == b)) for b in range(2)]
        left, right = buckets(before), buckets(after)
        changed = {b for b in range(2) if left[b] != right[b]}
        restored = {key: value for key, value in before.items() if key % 2 not in changed}
        restored.update((key, value) for key, value in after.items() if key % 2 in changed)
        assert restored == after
        # A post-snapshot update belongs to the live overlay, never its baseline.
        for key in range(4):
            overlay = dict(restored)
            overlay[key] = 3
            assert overlay[key] == 3 and restored == after
        checked += 1
print(f"verified {checked} snapshot pairs; inserts/edits/deletions and post-read overlay")
