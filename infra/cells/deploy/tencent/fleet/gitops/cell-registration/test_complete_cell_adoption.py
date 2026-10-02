#!/usr/bin/env python3
"""Static ownership and ordering contract for post-activation Cell adoption."""

from pathlib import Path
import unittest


SCRIPT = Path(__file__).with_name("complete-cell-adoption.sh")


class CompleteCellAdoptionTests(unittest.TestCase):
    def test_exact_review_chain_precedes_central_registration(self):
        source = SCRIPT.read_text()
        adopt = source.index('"$python" "$script_dir/adopt-cell.py"')
        wait = source.index("cell_adoption_phase=waiting_for_bound_claim")
        route = source.index('"$python" "$script_dir/publish-cell-route.py"')
        self.assertLess(adopt, wait)
        self.assertLess(wait, route)
        self.assertIn('--qualification-chain "$ACTOR_CELL_QUALIFICATION_CHAIN_RECEIPT"', source[:wait])
        self.assertIn('--activation-receipt "$ACTOR_QUALIFICATION_ACTIVATION_RECEIPT"', source[:wait])

    def test_claim_wait_is_uid_fenced_and_bounded(self):
        source = SCRIPT.read_text()
        self.assertIn('live_uid == "$claim_uid"', source)
        self.assertIn('live_pool_uid == "$pool_uid"', source)
        self.assertIn('observed_spoke_uid == "$spoke_uid"', source)
        self.assertIn("SECONDS < deadline", source)
        self.assertIn("phase == Bound", source)
        self.assertIn("phase != Failed", source)

    def test_entry_point_cannot_place_an_actor(self):
        source = SCRIPT.read_text()
        self.assertNotIn("qualify-first-placement.py", source)
        self.assertNotIn("complete-cell-admission.sh", source)
        self.assertNotIn("/v1/objects", source)

    def test_per_cell_lock_and_strict_receipt_paths_are_required(self):
        source = SCRIPT.read_text()
        self.assertIn(".cell-adoption-$cell.lock", source)
        self.assertIn("flock -n 9", source)
        self.assertIn("! -L $path", source)
        self.assertIn("! -L $output", source)


if __name__ == "__main__":
    unittest.main()
