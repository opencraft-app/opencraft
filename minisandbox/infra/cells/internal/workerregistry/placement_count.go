package workerregistry

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"math"
	"strings"
	"unicode/utf8"
)

func validateCellIdentity(cellName, cellUID string) error {
	if !namePattern.MatchString(cellName) {
		return fmt.Errorf("invalid Cell name")
	}
	if cellUID = strings.TrimSpace(cellUID); cellUID == "" || len(cellUID) > 128 || !utf8.ValidString(cellUID) {
		return fmt.Errorf("invalid Cell UID")
	}
	for _, character := range cellUID {
		if character < 0x21 || character == 0x7f {
			return fmt.Errorf("invalid Cell UID")
		}
	}
	return nil
}

func placementCountShard(namespace, worker, className, objectID string) int {
	digest := sha256.Sum256([]byte(namespace + "\x00" + worker + "\x00" + className + "\x00" + objectID))
	return int(digest[0] & (CellPlacementCountShards - 1))
}

func encodePlacementCountDelta(delta int64) []byte {
	encoded := make([]byte, 8)
	binary.LittleEndian.PutUint64(encoded, uint64(delta))
	return encoded
}

func decodePlacementCount(encoded []byte) (int64, error) {
	if len(encoded) != 8 {
		return 0, fmt.Errorf("invalid Cell placement counter encoding")
	}
	value := int64(binary.LittleEndian.Uint64(encoded))
	if value < 0 {
		return 0, fmt.Errorf("negative Cell placement counter")
	}
	return value, nil
}

func addPlacementCounts(total, value int64) (int64, error) {
	if value < 0 || total > math.MaxInt64-value {
		return 0, fmt.Errorf("Cell placement counter overflow")
	}
	return total + value, nil
}
