package workerregistry

import (
	"math"
	"testing"
)

func TestPlacementCountHelpersFailClosed(t *testing.T) {
	if err := validateCellIdentity("actor-bj-a01", "75df8bad-923a-4f0a-b7fb-fc8f16b67586"); err != nil {
		t.Fatal(err)
	}
	for _, identity := range [][2]string{{"", "uid"}, {"UPPER", "uid"}, {"cell", ""}, {"cell", "uid with space"}} {
		if err := validateCellIdentity(identity[0], identity[1]); err == nil {
			t.Fatalf("invalid identity accepted: %#v", identity)
		}
	}
	for _, delta := range []int64{0, 1, -1, math.MaxInt64} {
		encoded := encodePlacementCountDelta(delta)
		if delta >= 0 {
			decoded, err := decodePlacementCount(encoded)
			if err != nil || decoded != delta {
				t.Fatalf("round trip %d = %d, %v", delta, decoded, err)
			}
		} else if _, err := decodePlacementCount(encoded); err == nil {
			t.Fatal("negative counter accepted")
		}
	}
	if _, err := decodePlacementCount([]byte{1}); err == nil {
		t.Fatal("malformed counter accepted")
	}
	if _, err := addPlacementCounts(math.MaxInt64, 1); err == nil {
		t.Fatal("counter overflow accepted")
	}
}

func TestPlacementCountShardIsStableAndBounded(t *testing.T) {
	first := placementCountShard("default", "counter", "Counter", "abc")
	if first != placementCountShard("default", "counter", "Counter", "abc") || first < 0 || first >= CellPlacementCountShards {
		t.Fatalf("invalid stable shard %d", first)
	}
	seen := map[int]bool{}
	for index := 0; index < 1000; index++ {
		seen[placementCountShard("default", "counter", "Counter", string(rune(index)))] = true
	}
	if len(seen) < CellPlacementCountShards/2 {
		t.Fatalf("hash only used %d shards", len(seen))
	}
}
