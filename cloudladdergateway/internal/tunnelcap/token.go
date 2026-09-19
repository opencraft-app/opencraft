package tunnelcap

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"strconv"
	"strings"
)

const tokenPrefix = "lvdt1"

// Issue creates an opaque, one-time-returned capability for one UIN. Only the
// SHA-256 digest is persisted by the control plane.
func Issue(uin string, source io.Reader) (string, string, error) {
	uin = strings.TrimSpace(uin)
	if !validUIN(uin) {
		return "", "", errors.New("invalid tunnel capability uin")
	}
	if source == nil {
		source = rand.Reader
	}
	random := make([]byte, 32)
	if _, err := io.ReadFull(source, random); err != nil {
		return "", "", err
	}
	token := tokenPrefix + "." + uin + "." + base64.RawURLEncoding.EncodeToString(random)
	return token, Digest(token), nil
}

// UIN returns the UIN bound into a syntactically valid capability.
func UIN(token string) (string, bool) {
	parts := strings.Split(strings.TrimSpace(token), ".")
	if len(parts) != 3 || parts[0] != tokenPrefix || !validUIN(parts[1]) {
		return "", false
	}
	random, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(random) != 32 {
		return "", false
	}
	return parts[1], true
}

func Digest(token string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(token)))
	return hex.EncodeToString(sum[:])
}

func MatchesDigest(token string, expected string) bool {
	expectedBytes, err := hex.DecodeString(strings.TrimSpace(expected))
	if err != nil || len(expectedBytes) != sha256.Size {
		return false
	}
	actual := sha256.Sum256([]byte(strings.TrimSpace(token)))
	return subtle.ConstantTimeCompare(actual[:], expectedBytes) == 1
}

func ValidDigest(value string) bool {
	decoded, err := hex.DecodeString(strings.TrimSpace(value))
	return err == nil && len(decoded) == sha256.Size
}

func validUIN(uin string) bool {
	value, err := strconv.ParseUint(uin, 10, 64)
	return err == nil && value > 0 && strconv.FormatUint(value, 10) == uin
}
