package computermanagement

import (
	"encoding/base64"
	"errors"
	"math"
	"strconv"
	"strings"

	"github.com/google/uuid"
)

const enrollmentTokenPrefix = "cen1"

type enrollmentTokenRoute struct {
	ServerID   string
	ComputerID string
	Generation uint64
	Secret     []byte
}

func newEnrollmentToken(
	serverID string,
	computerID string,
	generation uint64,
	secret []byte,
) (string, error) {
	if !validEnrollmentUUID(serverID) || !validEnrollmentUUID(computerID) ||
		generation == 0 || generation > math.MaxInt64 || len(secret) != 32 {
		return "", errors.New("enrollment token 参数无效")
	}
	return strings.Join([]string{
		enrollmentTokenPrefix,
		serverID,
		computerID,
		strconv.FormatUint(generation, 10),
		base64.RawURLEncoding.EncodeToString(secret),
	}, "."), nil
}

func parseEnrollmentToken(value string) (enrollmentTokenRoute, error) {
	if len(value) < 100 || len(value) > 256 || strings.TrimSpace(value) != value {
		return enrollmentTokenRoute{}, errors.New("enrollment token 格式无效")
	}
	parts := strings.Split(value, ".")
	if len(parts) != 5 || parts[0] != enrollmentTokenPrefix ||
		!validEnrollmentUUID(parts[1]) || !validEnrollmentUUID(parts[2]) {
		return enrollmentTokenRoute{}, errors.New("enrollment token 路由无效")
	}
	generation, err := strconv.ParseUint(parts[3], 10, 64)
	if err != nil || generation == 0 || generation > math.MaxInt64 ||
		strconv.FormatUint(generation, 10) != parts[3] {
		return enrollmentTokenRoute{}, errors.New("enrollment generation 无效")
	}
	secret, err := base64.RawURLEncoding.Strict().DecodeString(parts[4])
	if err != nil || len(secret) != 32 {
		return enrollmentTokenRoute{}, errors.New("enrollment secret 无效")
	}
	return enrollmentTokenRoute{
		ServerID: parts[1], ComputerID: parts[2],
		Generation: generation, Secret: secret,
	}, nil
}

func validEnrollmentUUID(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed != uuid.Nil && parsed.Version() == 7 &&
		parsed.String() == value
}
