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

// LoadCatalog 只接受受限普通文件，并对象级绑定版本与 target。
func LoadCatalog(filename string) (computerport.ReleaseBinding, error) {
	info, err := os.Lstat(filename)
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > maxCatalogBytes {
		return computerport.ReleaseBinding{}, errors.New("Computer release catalog 文件无效")
	}
	file, err := os.Open(filename)
	if err != nil {
		return computerport.ReleaseBinding{}, errors.New("无法读取 Computer release catalog")
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, maxCatalogBytes+1))
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
		"program":   root + document.Target + "/raft-computer-go",
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
