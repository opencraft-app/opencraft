package selfupdate

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	rootstate "velachat/agent/internal/state"
)

const trustStatePath = "update/trust-state.json"

var (
	ErrTrustStateInvalid = errors.New("Computer Update trust state 无效")
	ErrUpdateReplay      = errors.New("Computer Update channel replay")
	ErrUpdateDowngrade   = errors.New("Computer Update version downgrade")
)

type TrustStateConfig struct {
	Root           string
	Channel        string
	Target         string
	CurrentVersion string
	Now            time.Time
}

type TrustSnapshot struct {
	HighestAcceptedSequence  int64
	AcceptedDescriptorSHA256 string
	AcceptedVersion          string
	HighestHealthyVersion    string
	UpdatedAt                time.Time
}

type trustStateDocument struct {
	SchemaVersion            int       `json:"schemaVersion"`
	Channel                  string    `json:"channel"`
	Target                   string    `json:"target"`
	HighestAcceptedSequence  int64     `json:"highestAcceptedSequence"`
	AcceptedDescriptorSHA256 string    `json:"acceptedDescriptorSHA256,omitempty"`
	AcceptedVersion          string    `json:"acceptedVersion,omitempty"`
	HighestHealthyVersion    string    `json:"highestHealthyVersion"`
	UpdatedAt                time.Time `json:"updatedAt"`
}

type TrustState struct {
	mu       sync.Mutex
	store    *rootstate.Store
	document trustStateDocument
}

func OpenTrustState(config TrustStateConfig) (*TrustState, error) {
	if !cleanAbsolute(config.Root) ||
		(config.Channel != "stable" && config.Channel != "canary") ||
		(config.Target != "darwin-arm64" && config.Target != "linux-amd64") ||
		!versionPattern.MatchString(config.CurrentVersion) || config.Now.IsZero() {
		return nil, ErrTrustStateInvalid
	}
	if err := ensurePrivateStateRoot(config.Root); err != nil {
		return nil, err
	}
	store := rootstate.New(config.Root)
	document, exists, err := readTrustState(config.Root)
	if err != nil {
		return nil, err
	}
	if !exists {
		document = trustStateDocument{
			SchemaVersion: 1, Channel: config.Channel, Target: config.Target,
			HighestHealthyVersion: config.CurrentVersion, UpdatedAt: config.Now.UTC(),
		}
		if err := store.Write(trustStatePath, document); err != nil {
			return nil, ErrTrustStateInvalid
		}
	} else {
		if err := validateTrustDocument(document, config.Channel, config.Target); err != nil {
			return nil, err
		}
	}
	return &TrustState{store: store, document: document}, nil
}

func (state *TrustState) Accept(value VerifiedChannel, now time.Time) (bool, error) {
	if state == nil || now.IsZero() || value.Descriptor.Channel != state.document.Channel ||
		value.Descriptor.Target != state.document.Target || value.Descriptor.Sequence < 1 ||
		!versionPattern.MatchString(value.Descriptor.ExpectedVersion) ||
		value.PayloadSHA256 == ([sha256.Size]byte{}) {
		return false, ErrTrustStateInvalid
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	digest := hex.EncodeToString(value.PayloadSHA256[:])
	if value.Descriptor.Sequence < state.document.HighestAcceptedSequence {
		return false, ErrUpdateReplay
	}
	if value.Descriptor.Sequence == state.document.HighestAcceptedSequence {
		if state.document.HighestAcceptedSequence > 0 &&
			state.document.AcceptedDescriptorSHA256 == digest {
			return false, nil
		}
		return false, ErrUpdateReplay
	}
	if compareVersions(value.Descriptor.ExpectedVersion, state.document.HighestHealthyVersion) < 0 {
		return false, ErrUpdateDowngrade
	}
	next := state.document
	next.HighestAcceptedSequence = value.Descriptor.Sequence
	next.AcceptedDescriptorSHA256 = digest
	next.AcceptedVersion = value.Descriptor.ExpectedVersion
	next.UpdatedAt = now.UTC()
	if err := state.store.Write(trustStatePath, next); err != nil {
		return false, ErrTrustStateInvalid
	}
	state.document = next
	return true, nil
}

func (state *TrustState) MarkHealthy(version string, now time.Time) error {
	if state == nil || now.IsZero() || !versionPattern.MatchString(version) {
		return ErrTrustStateInvalid
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.document.AcceptedVersion != "" && version != state.document.AcceptedVersion {
		return ErrTrustStateInvalid
	}
	if compareVersions(version, state.document.HighestHealthyVersion) < 0 {
		return ErrUpdateDowngrade
	}
	next := state.document
	next.HighestHealthyVersion = version
	next.UpdatedAt = now.UTC()
	if err := state.store.Write(trustStatePath, next); err != nil {
		return ErrTrustStateInvalid
	}
	state.document = next
	return nil
}

func (state *TrustState) Snapshot() TrustSnapshot {
	if state == nil {
		return TrustSnapshot{}
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	return TrustSnapshot{
		HighestAcceptedSequence:  state.document.HighestAcceptedSequence,
		AcceptedDescriptorSHA256: state.document.AcceptedDescriptorSHA256,
		AcceptedVersion:          state.document.AcceptedVersion,
		HighestHealthyVersion:    state.document.HighestHealthyVersion,
		UpdatedAt:                state.document.UpdatedAt,
	}
}

func readTrustState(root string) (trustStateDocument, bool, error) {
	filename := filepath.Join(root, trustStatePath)
	info, err := os.Lstat(filename)
	if errors.Is(err, os.ErrNotExist) {
		return trustStateDocument{}, false, nil
	}
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 ||
		info.Mode().Perm() != 0o600 || info.Size() <= 0 || info.Size() > 16*1024 {
		return trustStateDocument{}, false, ErrTrustStateInvalid
	}
	raw, err := os.ReadFile(filename)
	if err != nil || int64(len(raw)) != info.Size() {
		return trustStateDocument{}, false, ErrTrustStateInvalid
	}
	var document trustStateDocument
	if err := decodeExactJSON(raw, &document); err != nil {
		return trustStateDocument{}, false, ErrTrustStateInvalid
	}
	return document, true, nil
}

func validateTrustDocument(document trustStateDocument, channel, target string) error {
	if document.SchemaVersion != 1 || document.Channel != channel || document.Target != target ||
		document.HighestAcceptedSequence < 0 || !versionPattern.MatchString(document.HighestHealthyVersion) ||
		document.UpdatedAt.IsZero() {
		return ErrTrustStateInvalid
	}
	if document.HighestAcceptedSequence == 0 {
		if document.AcceptedDescriptorSHA256 != "" || document.AcceptedVersion != "" {
			return ErrTrustStateInvalid
		}
		return nil
	}
	if len(document.AcceptedDescriptorSHA256) != sha256.Size*2 ||
		strings.ToLower(document.AcceptedDescriptorSHA256) != document.AcceptedDescriptorSHA256 ||
		!versionPattern.MatchString(document.AcceptedVersion) {
		return ErrTrustStateInvalid
	}
	decoded, err := hex.DecodeString(document.AcceptedDescriptorSHA256)
	if err != nil || len(decoded) != sha256.Size {
		return ErrTrustStateInvalid
	}
	return nil
}

func ensurePrivateStateRoot(root string) error {
	if err := os.MkdirAll(root, 0o700); err != nil {
		return ErrTrustStateInvalid
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 ||
		info.Mode().Perm()&0o077 != 0 {
		return ErrTrustStateInvalid
	}
	return nil
}

func cleanAbsolute(value string) bool {
	return filepath.IsAbs(value) && filepath.Clean(value) == value &&
		!strings.ContainsAny(value, "\x00\r\n")
}

func compareVersions(left, right string) int {
	leftParts := versionParts(left)
	rightParts := versionParts(right)
	if leftParts == nil || rightParts == nil {
		return 0
	}
	for index := 0; index < 3; index++ {
		if compared := leftParts[index].number.Cmp(rightParts[index].number); compared != 0 {
			return compared
		}
	}
	leftSuffix := leftParts[3:]
	rightSuffix := rightParts[3:]
	if len(leftSuffix) == 0 && len(rightSuffix) > 0 {
		return 1
	}
	if len(leftSuffix) > 0 && len(rightSuffix) == 0 {
		return -1
	}
	for index := 0; index < len(leftSuffix) && index < len(rightSuffix); index++ {
		leftPart, rightPart := leftSuffix[index], rightSuffix[index]
		if leftPart.numeric && rightPart.numeric {
			if compared := leftPart.number.Cmp(rightPart.number); compared != 0 {
				return compared
			}
			continue
		}
		if leftPart.numeric != rightPart.numeric {
			if leftPart.numeric {
				return -1
			}
			return 1
		}
		if compared := strings.Compare(leftPart.text, rightPart.text); compared != 0 {
			return compared
		}
	}
	if len(leftSuffix) < len(rightSuffix) {
		return -1
	}
	if len(leftSuffix) > len(rightSuffix) {
		return 1
	}
	return 0
}

type versionPart struct {
	text    string
	number  *big.Int
	numeric bool
}

func versionParts(value string) []versionPart {
	if !versionPattern.MatchString(value) {
		return nil
	}
	parts := strings.FieldsFunc(strings.TrimPrefix(value, "v"), func(character rune) bool {
		return character == '.' || character == '-'
	})
	if len(parts) < 3 {
		return nil
	}
	result := make([]versionPart, 0, len(parts))
	for _, part := range parts {
		number, ok := new(big.Int).SetString(part, 10)
		result = append(result, versionPart{text: part, number: number, numeric: ok})
	}
	if !result[0].numeric || !result[1].numeric || !result[2].numeric {
		return nil
	}
	return result
}
