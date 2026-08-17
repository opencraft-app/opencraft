// Package computerrelease 读取并校验后台已批准的不可变 Computer 发布目录。
package computerrelease

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path"
	"strings"

	computerport "chatserver/internal/ports/computer"
)

const maxCatalogBytes = 64 * 1024

type artifactDocument struct {
	ObjectKey string `json:"objectKey"`
	SHA256    string `json:"sha256"`
	Size      int64  `json:"size"`
}

type catalogDocument struct {
	Version      string           `json:"version"`
	Target       string           `json:"target"`
	OSType       string           `json:"osType"`
	Architecture string           `json:"architecture"`
	SigningKeyID string           `json:"signingKeyId"`
	Manifest     artifactDocument `json:"manifest"`
	Signature    artifactDocument `json:"signature"`
	Installer    artifactDocument `json:"installer"`
	Program      artifactDocument `json:"program"`
}

type releaseSetDocument struct {
	Schema  string           `json:"schema"`
	Version string           `json:"version"`
	Targets []targetDocument `json:"targets"`
}

type targetDocument struct {
	Target       string           `json:"target"`
	OSType       string           `json:"osType"`
	Architecture string           `json:"architecture"`
	SigningKeyID string           `json:"signingKeyId"`
	Manifest     artifactDocument `json:"manifest"`
	Signature    artifactDocument `json:"signature"`
	Installer    artifactDocument `json:"installer"`
	Program      artifactDocument `json:"program"`
}

// LoadCatalog 只接受受限普通文件，并对象级绑定版本与 target。
func LoadCatalog(filename string) (computerport.ReleaseBinding, error) {
	raw, err := readCatalog(filename)
	if err != nil {
		return computerport.ReleaseBinding{}, err
	}
	return decodeLegacyCatalog(raw)
}

// LoadReleaseSet reads the formal two-target catalog and the strict read-only legacy macOS catalog.
func LoadReleaseSet(filename string) (computerport.ReleaseSet, error) {
	raw, err := readCatalog(filename)
	if err != nil {
		return computerport.ReleaseSet{}, err
	}
	var probe struct {
		Schema *string `json:"schema"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return computerport.ReleaseSet{}, errors.New("Computer release catalog JSON 无效")
	}
	if probe.Schema == nil {
		release, err := decodeLegacyCatalog(raw)
		if err != nil || release.Target != "darwin-arm64" || release.OSType != "macos" ||
			release.Architecture != "arm64" {
			return computerport.ReleaseSet{}, errors.New("Computer legacy release catalog 无效")
		}
		return computerport.ReleaseSet{
			Version: release.Version, Releases: []computerport.ReleaseBinding{release},
		}, nil
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	var document releaseSetDocument
	if err := decoder.Decode(&document); err != nil || decoder.Decode(&struct{}{}) != io.EOF ||
		document.Schema != "agent-network-computer-release-set/v1" ||
		!validComponent(document.Version) || len(document.Targets) != 2 {
		return computerport.ReleaseSet{}, errors.New("Computer release set JSON 无效")
	}
	wantTargets := []string{"darwin-arm64", "linux-amd64"}
	result := computerport.ReleaseSet{Version: document.Version}
	for index, target := range document.Targets {
		if target.Target != wantTargets[index] {
			return computerport.ReleaseSet{}, errors.New("Computer release set target 顺序无效")
		}
		release, err := parseTargetDocument(document.Version, target)
		if err != nil {
			return computerport.ReleaseSet{}, err
		}
		result.Releases = append(result.Releases, release)
	}
	return result, nil
}

func readCatalog(filename string) ([]byte, error) {
	info, err := os.Lstat(filename)
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > maxCatalogBytes {
		return nil, errors.New("Computer release catalog 文件无效")
	}
	file, err := os.Open(filename)
	if err != nil {
		return nil, errors.New("无法读取 Computer release catalog")
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, maxCatalogBytes+1))
	if err != nil || int64(len(raw)) != info.Size() {
		return nil, errors.New("无法读取 Computer release catalog")
	}
	return raw, nil
}

func decodeLegacyCatalog(raw []byte) (computerport.ReleaseBinding, error) {
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	var document catalogDocument
	if err := decoder.Decode(&document); err != nil || decoder.Decode(&struct{}{}) != io.EOF {
		return computerport.ReleaseBinding{}, errors.New("Computer release catalog JSON 无效")
	}
	root := "computer/releases/" + document.Version + "/"
	want := map[string]string{
		"manifest":  root + "manifest.json",
		"signature": root + "manifest.sig",
		"installer": root + document.Target + "/install.sh",
		"program":   root + document.Target + "/vela-computer",
	}
	manifest, err := parseArtifact(document.Manifest, want["manifest"])
	if err != nil {
		return computerport.ReleaseBinding{}, err
	}
	signature, err := parseArtifact(document.Signature, want["signature"])
	if err != nil {
		return computerport.ReleaseBinding{}, err
	}
	installer, err := parseArtifact(document.Installer, want["installer"])
	if err != nil {
		return computerport.ReleaseBinding{}, err
	}
	program, err := parseArtifact(document.Program, want["program"])
	if err != nil {
		return computerport.ReleaseBinding{}, err
	}
	if !validComponent(document.Version) || !validComponent(document.Target) ||
		!validComponent(document.OSType) || !validComponent(document.Architecture) ||
		!validComponent(document.SigningKeyID) ||
		document.Target != document.OSTypeTarget() {
		return computerport.ReleaseBinding{}, errors.New("Computer release catalog 平台绑定无效")
	}
	return computerport.ReleaseBinding{
		Version: document.Version, Target: document.Target,
		OSType: document.OSType, Architecture: document.Architecture,
		SigningKeyID: document.SigningKeyID,
		Manifest:     manifest, Signature: signature, Installer: installer, Program: program,
	}, nil
}

func parseTargetDocument(version string, document targetDocument) (computerport.ReleaseBinding, error) {
	root := "computer/releases/" + version + "/" + document.Target + "/"
	manifest, err := parseArtifact(document.Manifest, root+"manifest.json")
	if err != nil {
		return computerport.ReleaseBinding{}, err
	}
	signature, err := parseArtifact(document.Signature, root+"manifest.sig")
	if err != nil {
		return computerport.ReleaseBinding{}, err
	}
	installer, err := parseArtifact(document.Installer, root+"install.sh")
	if err != nil {
		return computerport.ReleaseBinding{}, err
	}
	program, err := parseArtifact(document.Program, root+"vela-computer")
	if err != nil {
		return computerport.ReleaseBinding{}, err
	}
	probe := catalogDocument{
		OSType: document.OSType, Architecture: document.Architecture,
	}
	if !validComponent(document.Target) || !validComponent(document.OSType) ||
		!validComponent(document.Architecture) || !validComponent(document.SigningKeyID) ||
		document.Target != probe.OSTypeTarget() {
		return computerport.ReleaseBinding{}, errors.New("Computer release set 平台绑定无效")
	}
	return computerport.ReleaseBinding{
		Version: version, Target: document.Target, OSType: document.OSType,
		Architecture: document.Architecture, SigningKeyID: document.SigningKeyID,
		Manifest: manifest, Signature: signature, Installer: installer, Program: program,
	}, nil
}

func (document catalogDocument) OSTypeTarget() string {
	if document.OSType == "macos" {
		return "darwin-" + document.Architecture
	}
	return document.OSType + "-" + document.Architecture
}

func parseArtifact(document artifactDocument, expectedKey string) (computerport.ArtifactBinding, error) {
	if document.ObjectKey != expectedKey || document.Size <= 0 || !validObjectKey(document.ObjectKey) ||
		len(document.SHA256) != 64 || strings.ToLower(document.SHA256) != document.SHA256 {
		return computerport.ArtifactBinding{}, errors.New("Computer release artifact 绑定无效")
	}
	digest, err := hex.DecodeString(document.SHA256)
	if err != nil || len(digest) != 32 {
		return computerport.ArtifactBinding{}, errors.New("Computer release artifact 摘要无效")
	}
	var hash [32]byte
	copy(hash[:], digest)
	return computerport.ArtifactBinding{ObjectKey: document.ObjectKey, SHA256: hash, Size: document.Size}, nil
}

func validComponent(value string) bool {
	if value == "" || len(value) > 64 {
		return false
	}
	for index, character := range value {
		if (character >= 'a' && character <= 'z') ||
			(character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') ||
			(index > 0 && (character == '.' || character == '_' || character == '-')) {
			continue
		}
		return false
	}
	return true
}

func validObjectKey(value string) bool {
	return value != "" && !path.IsAbs(value) && path.Clean(value) == value &&
		!strings.Contains(value, "..") && !strings.ContainsAny(value, "\r\n\x00")
}
