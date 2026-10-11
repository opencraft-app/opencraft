package selfupdate

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"strings"

	velainstall "velachat/agent/internal/vela/install"
)

const (
	maximumReleaseCatalogBytes = 64 * 1024
	maximumManifestBytes       = 64 * 1024
	maximumProgramBytes        = 512 * 1024 * 1024
)

var ErrReleaseInvalid = errors.New("Computer Update release 无效")

type ReleasePaths struct {
	Catalog           string
	Manifest          string
	ManifestSignature string
	Program           string
}

type VerifyReleaseFilesConfig struct {
	Channel           VerifiedChannel
	Paths             ReleasePaths
	ReleasePublicKeys map[string]ed25519.PublicKey
}

type VerifiedRelease struct {
	Version       string
	Target        string
	SigningKeyID  string
	ProgramSHA256 [sha256.Size]byte
	ProgramSize   int64
}

type releaseArtifactDocument struct {
	ObjectKey string `json:"objectKey"`
	SHA256    string `json:"sha256"`
	Size      int64  `json:"size"`
}

type releaseTargetDocument struct {
	Target       string                  `json:"target"`
	OSType       string                  `json:"osType"`
	Architecture string                  `json:"architecture"`
	SigningKeyID string                  `json:"signingKeyId"`
	Manifest     releaseArtifactDocument `json:"manifest"`
	Signature    releaseArtifactDocument `json:"signature"`
	Installer    releaseArtifactDocument `json:"installer"`
	Program      releaseArtifactDocument `json:"program"`
}

type releaseCatalogDocument struct {
	Schema  string                  `json:"schema"`
	Version string                  `json:"version"`
	Targets []releaseTargetDocument `json:"targets"`
}

type releaseArtifact struct {
	objectKey string
	digest    [sha256.Size]byte
	size      int64
}

type releaseTarget struct {
	target       string
	signingKeyID string
	manifest     releaseArtifact
	signature    releaseArtifact
	installer    releaseArtifact
	program      releaseArtifact
}

func VerifyReleaseFiles(config VerifyReleaseFilesConfig) (VerifiedRelease, error) {
	descriptor := config.Channel.Descriptor
	if descriptor.SchemaVersion != 1 ||
		(descriptor.Target != "darwin-arm64" && descriptor.Target != "linux-amd64") ||
		!versionPattern.MatchString(descriptor.ExpectedVersion) || len(config.ReleasePublicKeys) == 0 {
		return VerifiedRelease{}, ErrReleaseInvalid
	}
	for _, path := range []string{
		config.Paths.Catalog, config.Paths.Manifest,
		config.Paths.ManifestSignature, config.Paths.Program,
	} {
		if !cleanAbsolute(path) {
			return VerifiedRelease{}, ErrReleaseInvalid
		}
	}
	catalogBytes, err := readSmallReleaseFile(config.Paths.Catalog, maximumReleaseCatalogBytes)
	catalogDigest := sha256.Sum256(catalogBytes)
	if err != nil || subtle.ConstantTimeCompare(
		catalogDigest[:], descriptor.CatalogSHA256[:],
	) != 1 {
		return VerifiedRelease{}, ErrReleaseInvalid
	}
	var catalog releaseCatalogDocument
	if err := decodeExactJSON(catalogBytes, &catalog); err != nil ||
		catalog.Schema != "agent-network-computer-release-set/v1" ||
		catalog.Version != descriptor.ExpectedVersion || len(catalog.Targets) != 2 {
		return VerifiedRelease{}, ErrReleaseInvalid
	}
	wantTargets := []string{"darwin-arm64", "linux-amd64"}
	var selected releaseTarget
	for index, document := range catalog.Targets {
		if document.Target != wantTargets[index] {
			return VerifiedRelease{}, ErrReleaseInvalid
		}
		target, err := parseReleaseTarget(catalog.Version, document)
		if err != nil {
			return VerifiedRelease{}, err
		}
		if target.target == descriptor.Target {
			selected = target
		}
	}
	if selected.target == "" {
		return VerifiedRelease{}, ErrReleaseInvalid
	}
	publicKey := config.ReleasePublicKeys[selected.signingKeyID]
	if len(publicKey) != ed25519.PublicKeySize ||
		verifyFileBinding(config.Paths.Manifest, selected.manifest, maximumManifestBytes) != nil ||
		verifyFileBinding(config.Paths.ManifestSignature, selected.signature, ed25519.SignatureSize) != nil ||
		verifyFileBinding(config.Paths.Program, selected.program, maximumProgramBytes) != nil {
		return VerifiedRelease{}, ErrReleaseInvalid
	}
	verified, err := velainstall.VerifyRelease(velainstall.VerifyConfig{
		ManifestPath: config.Paths.Manifest, SignaturePath: config.Paths.ManifestSignature,
		ProgramPath: config.Paths.Program,
		PublicKey:   base64.RawStdEncoding.EncodeToString(publicKey),
		Version:     descriptor.ExpectedVersion, Target: descriptor.Target,
	})
	if err != nil || verified.SigningKeyID != selected.signingKeyID ||
		verified.ProgramSHA256 != selected.program.digest ||
		verified.ProgramSize != selected.program.size {
		return VerifiedRelease{}, ErrReleaseInvalid
	}
	return VerifiedRelease{
		Version: verified.Version, Target: verified.Target,
		SigningKeyID:  verified.SigningKeyID,
		ProgramSHA256: verified.ProgramSHA256, ProgramSize: verified.ProgramSize,
	}, nil
}

func parseReleaseTarget(version string, document releaseTargetDocument) (releaseTarget, error) {
	if !keyIDPattern.MatchString(document.SigningKeyID) {
		return releaseTarget{}, ErrReleaseInvalid
	}
	wantOS, wantArchitecture := "", ""
	switch document.Target {
	case "darwin-arm64":
		wantOS, wantArchitecture = "macos", "arm64"
	case "linux-amd64":
		wantOS, wantArchitecture = "linux", "amd64"
	default:
		return releaseTarget{}, ErrReleaseInvalid
	}
	if document.OSType != wantOS || document.Architecture != wantArchitecture {
		return releaseTarget{}, ErrReleaseInvalid
	}
	root := "computer/releases/" + version + "/" + document.Target + "/"
	manifest, err := parseReleaseArtifact(document.Manifest, root+"manifest.json")
	if err != nil {
		return releaseTarget{}, err
	}
	signature, err := parseReleaseArtifact(document.Signature, root+"manifest.sig")
	if err != nil || signature.size != ed25519.SignatureSize {
		return releaseTarget{}, ErrReleaseInvalid
	}
	installer, err := parseReleaseArtifact(document.Installer, root+"install.sh")
	if err != nil {
		return releaseTarget{}, err
	}
	program, err := parseReleaseArtifact(document.Program, root+"vela-computer")
	if err != nil || program.size > maximumProgramBytes {
		return releaseTarget{}, ErrReleaseInvalid
	}
	return releaseTarget{
		target: document.Target, signingKeyID: document.SigningKeyID,
		manifest: manifest, signature: signature, installer: installer, program: program,
	}, nil
}

func parseReleaseArtifact(document releaseArtifactDocument, objectKey string) (releaseArtifact, error) {
	if document.ObjectKey != objectKey || document.Size <= 0 ||
		len(document.SHA256) != sha256.Size*2 ||
		strings.ToLower(document.SHA256) != document.SHA256 {
		return releaseArtifact{}, ErrReleaseInvalid
	}
	decoded, err := hex.DecodeString(document.SHA256)
	if err != nil || len(decoded) != sha256.Size {
		return releaseArtifact{}, ErrReleaseInvalid
	}
	var digest [sha256.Size]byte
	copy(digest[:], decoded)
	return releaseArtifact{objectKey: objectKey, digest: digest, size: document.Size}, nil
}

func verifyFileBinding(filename string, artifact releaseArtifact, maximum int64) error {
	info, err := os.Lstat(filename)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 ||
		info.Size() != artifact.size || info.Size() <= 0 || info.Size() > maximum {
		return ErrReleaseInvalid
	}
	file, err := os.Open(filename)
	if err != nil {
		return ErrReleaseInvalid
	}
	digest := sha256.New()
	written, copyErr := io.Copy(digest, file)
	closeErr := file.Close()
	if copyErr != nil || closeErr != nil || written != artifact.size ||
		subtle.ConstantTimeCompare(digest.Sum(nil), artifact.digest[:]) != 1 {
		return ErrReleaseInvalid
	}
	return nil
}

func readSmallReleaseFile(filename string, maximum int64) ([]byte, error) {
	info, err := os.Lstat(filename)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 ||
		info.Size() <= 0 || info.Size() > maximum {
		return nil, ErrReleaseInvalid
	}
	file, err := os.Open(filename)
	if err != nil {
		return nil, ErrReleaseInvalid
	}
	defer file.Close()
	content, err := io.ReadAll(io.LimitReader(file, maximum+1))
	if err != nil || int64(len(content)) != info.Size() {
		return nil, ErrReleaseInvalid
	}
	return content, nil
}
