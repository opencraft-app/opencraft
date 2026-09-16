package schemaaudit

import "testing"

func TestNormalizeTopology接受连续单Set或多Set区间(t *testing.T) {
	tests := [][]TopologyObservation{
		{{OpaqueID: "set-a", HashRange: "0-63"}},
		{
			{OpaqueID: "set-b", HashRange: "32---63"},
			{OpaqueID: "set-a", HashRange: "0---31"},
		},
	}
	for _, observations := range tests {
		sets, err := normalizeTopology(observations)
		if err != nil {
			t.Fatalf("normalizeTopology() error = %v", err)
		}
		if len(sets) != len(observations) || sets[0].RangeStart != 0 {
			t.Fatalf("sets = %#v", sets)
		}
	}
}

func TestNormalizeTopology拒绝空结果重复Set非法Range空洞和重叠(t *testing.T) {
	tests := [][]TopologyObservation{
		nil,
		{{OpaqueID: "set-a", HashRange: "bad"}},
		{{OpaqueID: "set-a", HashRange: "5-1"}},
		{{OpaqueID: "set-a", HashRange: "0-31"}, {OpaqueID: "set-a", HashRange: "32-63"}},
		{{OpaqueID: "set-a", HashRange: "0-30"}, {OpaqueID: "set-b", HashRange: "32-63"}},
		{{OpaqueID: "set-a", HashRange: "0-32"}, {OpaqueID: "set-b", HashRange: "32-63"}},
	}
	for index, observations := range tests {
		if _, err := normalizeTopology(observations); err == nil {
			t.Fatalf("case %d 应失败：%#v", index, observations)
		}
	}
}

func TestVerifyAllsetsVector要求每表每Set恰好存在一次(t *testing.T) {
	sets := []Set{{OpaqueID: "set-a"}, {OpaqueID: "set-b"}}
	if err := verifyAllsetsVector(sets, []AllsetsObservation{
		{OpaqueID: "set-b", Count: 1}, {OpaqueID: "set-a", Count: 1},
	}); err != nil {
		t.Fatalf("verifyAllsetsVector() error = %v", err)
	}
	bad := [][]AllsetsObservation{
		{{OpaqueID: "set-a", Count: 1}},
		{{OpaqueID: "set-a", Count: 1}, {OpaqueID: "set-b", Count: 0}},
		{{OpaqueID: "set-a", Count: 1}, {OpaqueID: "unknown", Count: 1}},
		{{OpaqueID: "set-a", Count: 1}, {OpaqueID: "set-a", Count: 1}},
	}
	for index, observations := range bad {
		if err := verifyAllsetsVector(sets, observations); err == nil {
			t.Fatalf("case %d 应失败：%#v", index, observations)
		}
	}
}
