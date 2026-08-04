package schemaaudit

import (
	"cmp"
	"fmt"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// TopologyObservation 是从 Proxy status 中提取的最小非持久化信息。
type TopologyObservation struct {
	OpaqueID  string
	HashRange string
}

// Set 是规范化且按 hash range 排序的 TDSQL set。
type Set struct {
	OpaqueID   string
	RangeStart uint64
	RangeEnd   uint64
}

// AllsetsObservation 是一张表在一个物理 set 的存在计数。
type AllsetsObservation struct {
	OpaqueID string
	Count    int
}

var hashRangePattern = regexp.MustCompile(`^\s*([0-9]+)\s*-{1,3}\s*([0-9]+)\s*$`)

func normalizeTopology(observations []TopologyObservation) ([]Set, error) {
	if len(observations) == 0 {
		return nil, fmt.Errorf("proxy topology is empty")
	}
	sets := make([]Set, 0, len(observations))
	identities := make(map[string]struct{}, len(observations))
	for _, observation := range observations {
		identity := strings.TrimSpace(observation.OpaqueID)
		if identity == "" {
			return nil, fmt.Errorf("proxy set identity is empty")
		}
		if _, duplicate := identities[identity]; duplicate {
			return nil, fmt.Errorf("proxy set identity is duplicated")
		}
		identities[identity] = struct{}{}
		matches := hashRangePattern.FindStringSubmatch(observation.HashRange)
		if len(matches) != 3 {
			return nil, fmt.Errorf("proxy hash range is invalid")
		}
		start, err := strconv.ParseUint(matches[1], 10, 64)
		if err != nil {
			return nil, fmt.Errorf("proxy hash range start is invalid")
		}
		end, err := strconv.ParseUint(matches[2], 10, 64)
		if err != nil || start > end {
			return nil, fmt.Errorf("proxy hash range end is invalid")
		}
		sets = append(sets, Set{OpaqueID: identity, RangeStart: start, RangeEnd: end})
	}
	slices.SortFunc(sets, func(left, right Set) int {
		return cmp.Compare(left.RangeStart, right.RangeStart)
	})
	if sets[0].RangeStart != 0 {
		return nil, fmt.Errorf("proxy hash range does not start at zero")
	}
	for index := 1; index < len(sets); index++ {
		previous := sets[index-1]
		if previous.RangeEnd == math.MaxUint64 || sets[index].RangeStart != previous.RangeEnd+1 {
			return nil, fmt.Errorf("proxy hash ranges have a gap or overlap")
		}
	}
	return sets, nil
}

func verifyAllsetsVector(sets []Set, observations []AllsetsObservation) error {
	if len(sets) == 0 || len(observations) != len(sets) {
		return fmt.Errorf("allsets result count mismatch")
	}
	expected := make(map[string]struct{}, len(sets))
	for _, set := range sets {
		expected[set.OpaqueID] = struct{}{}
	}
	seen := make(map[string]struct{}, len(observations))
	for _, observation := range observations {
		if _, ok := expected[observation.OpaqueID]; !ok {
			return fmt.Errorf("allsets returned unknown set")
		}
		if _, duplicate := seen[observation.OpaqueID]; duplicate {
			return fmt.Errorf("allsets returned duplicate set")
		}
		if observation.Count != 1 {
			return fmt.Errorf("table is not present exactly once in a set")
		}
		seen[observation.OpaqueID] = struct{}{}
	}
	return nil
}
