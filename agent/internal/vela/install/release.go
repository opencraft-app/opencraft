// Package install implements the first-install boundary for the canonical
// Vela Computer binary.
package install

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path"
	"strings"

	"velachat/agent/internal/common"
)

const (
	ManifestSchema  = "agent-network-computer-release/v1"
	ProgramName     = "vela-computer"
	maxManifestSize = 64 * 1024
)

var ErrReleaseInvalid = errors.New("Computer 发布制品无效")

type VerifyConfig struct {
	ManifestPath  string
	SignaturePath string
	ProgramPath   string
	PublicKey     string
	Version       string
	Target        string
}

type VerifiedRelease struct {
	Version       string
	Target        string
	SigningKeyID  string
	ProgramSHA256 [sha256.Size]byte
	ProgramSize   int64
	ProgramObject string
}

type manifestDocument struct {
	Schema       string                 `json:"schema"`
	Version      string                 `json:"version"`
	Target       string                 `json:"target"`
	SigningKeyID string                 `json:"signingKeyId"`
	Files        []manifestFileDocument `json:"files"`
}

type manifestFileDocument struct {
	Name      string `json:"name"`
	ObjectKey string `json:"objectKey"`
	SHA256    string `json:"sha256"`
	Size      int64  `json:"size"`
}

func VerifyRelease(config VerifyConfig) (VerifiedRelease, error) {
	if !validComponent(config.Version) || !validComponent(config.Target) {
		return VerifiedRelease{}, ErrReleaseInvalid
	}
	publicKey, err := base64.RawStdEncoding.Strict().DecodeString(config.PublicKey)
	if err != nil || len(publicKey) != ed25519.PublicKeySize {
		return VerifiedRelease{}, ErrReleaseInvalid
	}
	manifest, err := readRegular(config.ManifestPath, maxManifestSize)
	if err != nil {
		return VerifiedRelease{}, err
	}
	signature, err := readRegular(config.SignaturePath, ed25519.SignatureSize)
	if err != nil || len(signature) != ed25519.SignatureSize ||
		!ed25519.Verify(ed25519.PublicKey(publicKey), manifest, signature) {
		return VerifiedRelease{}, ErrReleaseInvalid
	}
	var fields map[string]json.RawMessage
	if err := common.Unmarshal(manifest, &fields); err != nil ||
		!exactKeys(fields, "schema", "version", "target", "signingKeyId", "files") {
		return VerifiedRelease{}, ErrReleaseInvalid
	}
	var document manifestDocument
	if err := common.Unmarshal(manifest, &document); err != nil ||
		document.Schema != ManifestSchema || document.Version != config.Version ||
		document.Target != config.Target || !validComponent(document.SigningKeyID) ||
		len(document.Files) != 1 {
		return VerifiedRelease{}, ErrReleaseInvalid
	}
	program := document.Files[0]
	wantObject := "computer/releases/" + config.Version + "/" +
		config.Target + "/" + ProgramName
	if program.Name != ProgramName || program.ObjectKey != wantObject ||
		path.Clean(program.ObjectKey) != program.ObjectKey || program.Size <= 0 ||
		len(program.SHA256) != sha256.Size*2 || strings.ToLower(program.SHA256) != program.SHA256 {
		return VerifiedRelease{}, ErrReleaseInvalid
	}
	expected, err := hex.DecodeString(program.SHA256)
	if err != nil || len(expected) != sha256.Size {
		return VerifiedRelease{}, ErrReleaseInvalid
	}
	actual, size, err := hashRegular(config.ProgramPath)
	if err != nil || size != program.Size ||
		subtle.ConstantTimeCompare(actual[:], expected) != 1 {
		return VerifiedRelease{}, ErrReleaseInvalid
	}
	return VerifiedRelease{
		Version: document.Version, Target: document.Target,
		SigningKeyID: document.SigningKeyID, ProgramSHA256: actual,
		ProgramSize: size, ProgramObject: program.ObjectKey,
	}, nil
}

func exactKeys(fields map[string]json.RawMessage, expected ...string) bool {
	if len(fields) != len(expected) {
		return false
	}
	for _, key := range expected {
		if _, ok := fields[key]; !ok {
			return false
		}
	}
	return true
}

func readRegular(filename string, limit int64) ([]byte, error) {
	before, err := os.Lstat(filename)
	if err != nil || !before.Mode().IsRegular() || before.Mode()&os.ModeSymlink != 0 ||
		before.Size() < 1 || before.Size() > limit {
		return nil, ErrReleaseInvalid
	}
	file, err := os.Open(filename)
	if err != nil {
		return nil, ErrReleaseInvalid
	}
	defer file.Close()
	after, err := file.Stat()
	if err != nil || !os.SameFile(before, after) {
		return nil, ErrReleaseInvalid
	}
	content, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(content)) != before.Size() {
		return nil, ErrReleaseInvalid
	}
	return content, nil
}

func hashRegular(filename string) ([sha256.Size]byte, int64, error) {
	before, err := os.Lstat(filename)
	if err != nil || !before.Mode().IsRegular() || before.Mode()&os.ModeSymlink != 0 || before.Size() < 1 {
		return [sha256.Size]byte{}, 0, ErrReleaseInvalid
	}
	file, err := os.Open(filename)
	if err != nil {
		return [sha256.Size]byte{}, 0, ErrReleaseInvalid
	}
	defer file.Close()
	after, err := file.Stat()
	if err != nil || !os.SameFile(before, after) {
		return [sha256.Size]byte{}, 0, ErrReleaseInvalid
	}
	digest := sha256.New()
	written, err := io.Copy(digest, file)
	if err != nil || written != before.Size() {
		return [sha256.Size]byte{}, 0, ErrReleaseInvalid
	}
	var result [sha256.Size]byte
	copy(result[:], digest.Sum(nil))
	return result, written, nil
}

func validComponent(value string) bool {
	if value == "" || len(value) > 64 {
		return false
	}
	for index, character := range value {
		if character >= 'a' && character <= 'z' ||
			character >= 'A' && character <= 'Z' ||
			character >= '0' && character <= '9' ||
			index > 0 && (character == '.' || character == '_' || character == '-') {
			continue
		}
		return false
	}
	return true
}
