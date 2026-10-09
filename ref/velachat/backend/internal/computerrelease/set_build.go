package computerrelease

import (
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"

	computerport "chatserver/internal/ports/computer"
)

type ReleaseTargetBuildConfig struct {
	Target        string
	OSType        string
	Architecture  string
	ProgramPath   string
	InstallerPath string
}

type ReleaseSetBuildConfig struct {
	Version         string
	SigningKeyID    string
	PrivateKey      ed25519.PrivateKey
	OutputDirectory string
	Targets         []ReleaseTargetBuildConfig
}

type ReleaseSetBundle struct {
	ReleaseSet      computerport.ReleaseSet
	Bundles         []Bundle
	CatalogPath     string
	OutputDirectory string
}

func BuildReleaseSet(config ReleaseSetBuildConfig) (ReleaseSetBundle, error) {
	if !validComponent(config.Version) || !validComponent(config.SigningKeyID) ||
		len(config.PrivateKey) != ed25519.PrivateKeySize || !filepath.IsAbs(config.OutputDirectory) ||
		len(config.Targets) != 2 {
		return ReleaseSetBundle{}, errors.New("Computer release set build 配置无效")
	}
	targets := append([]ReleaseTargetBuildConfig(nil), config.Targets...)
	sort.Slice(targets, func(left, right int) bool { return targets[left].Target < targets[right].Target })
	if targets[0].Target != "darwin-arm64" || targets[1].Target != "linux-amd64" {
		return ReleaseSetBundle{}, errors.New("Computer release set target 配置无效")
	}
	if _, err := os.Lstat(config.OutputDirectory); !errors.Is(err, os.ErrNotExist) {
		return ReleaseSetBundle{}, errors.New("Computer release set 输出目录已存在")
	}
	if err := os.MkdirAll(config.OutputDirectory, 0o700); err != nil {
		return ReleaseSetBundle{}, err
	}
	complete := false
	defer func() {
		if !complete {
			_ = os.RemoveAll(config.OutputDirectory)
		}
	}()
	result := ReleaseSetBundle{
		ReleaseSet:      computerport.ReleaseSet{Version: config.Version},
		CatalogPath:     filepath.Join(config.OutputDirectory, "release.catalog.json"),
		OutputDirectory: config.OutputDirectory,
	}
	for _, target := range targets {
		bundle, err := buildReleaseSetTarget(config, target)
		if err != nil {
			return ReleaseSetBundle{}, err
		}
		result.Bundles = append(result.Bundles, bundle)
		result.ReleaseSet.Releases = append(result.ReleaseSet.Releases, bundle.Release)
	}
	document := releaseSetDocument{
		Schema: "agent-network-computer-release-set/v1", Version: config.Version,
	}
	for _, release := range result.ReleaseSet.Releases {
		document.Targets = append(document.Targets, targetDocumentFromRelease(release))
	}
	catalog, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return ReleaseSetBundle{}, err
	}
	catalog = append(catalog, '\n')
	if err := writeExclusive(result.CatalogPath, catalog, 0o644); err != nil {
		return ReleaseSetBundle{}, err
	}
	complete = true
	return result, nil
}

func buildReleaseSetTarget(
	config ReleaseSetBuildConfig,
	target ReleaseTargetBuildConfig,
) (Bundle, error) {
	probe := catalogDocument{OSType: target.OSType, Architecture: target.Architecture}
	if !validComponent(target.Target) || target.Target != probe.OSTypeTarget() ||
		!filepath.IsAbs(target.ProgramPath) ||
		(target.InstallerPath != "" && !filepath.IsAbs(target.InstallerPath)) {
		return Bundle{}, errors.New("Computer release set target 配置无效")
	}
	directory := filepath.Join(config.OutputDirectory, target.Target)
	if err := os.Mkdir(directory, 0o700); err != nil {
		return Bundle{}, err
	}
	bundle := Bundle{
		ProgramPath:   filepath.Join(directory, "vela-computer"),
		InstallerPath: filepath.Join(directory, "install.sh"),
		ManifestPath:  filepath.Join(directory, "manifest.json"),
		SignaturePath: filepath.Join(directory, "manifest.sig"),
	}
	if err := copyExclusive(target.ProgramPath, bundle.ProgramPath, 0o755); err != nil {
		return Bundle{}, err
	}
	objectRoot := "computer/releases/" + config.Version + "/" + target.Target + "/"
	program, err := artifactFor(bundle.ProgramPath, objectRoot+"vela-computer")
	if err != nil {
		return Bundle{}, err
	}
	manifest := manifestDocument{
		Schema: manifestSchema, Version: config.Version, Target: target.Target,
		SigningKeyID: config.SigningKeyID,
		Files: []manifestFileDocument{{
			Name: "vela-computer", ObjectKey: program.ObjectKey,
			SHA256: hex.EncodeToString(program.SHA256[:]), Size: program.Size,
		}},
	}
	manifestBytes, err := json.Marshal(manifest)
	if err != nil {
		return Bundle{}, err
	}
	manifestBytes = append(manifestBytes, '\n')
	if err := writeExclusive(bundle.ManifestPath, manifestBytes, 0o644); err != nil {
		return Bundle{}, err
	}
	if err := writeExclusive(
		bundle.SignaturePath, ed25519.Sign(config.PrivateKey, manifestBytes), 0o644,
	); err != nil {
		return Bundle{}, err
	}
	manifestArtifact, err := artifactFor(bundle.ManifestPath, objectRoot+"manifest.json")
	if err != nil {
		return Bundle{}, err
	}
	signatureArtifact, err := artifactFor(bundle.SignaturePath, objectRoot+"manifest.sig")
	if err != nil {
		return Bundle{}, err
	}
	buildConfig := BuildConfig{
		Version: config.Version, Target: target.Target, OSType: target.OSType,
		Architecture: target.Architecture, SigningKeyID: config.SigningKeyID,
		PrivateKey: config.PrivateKey,
	}
	if target.InstallerPath != "" {
		if err := copyExclusive(target.InstallerPath, bundle.InstallerPath, 0o755); err != nil {
			return Bundle{}, err
		}
	} else {
		installer, err := renderInstaller(buildConfig, program, manifestArtifact, signatureArtifact)
		if err != nil {
			return Bundle{}, err
		}
		if err := writeExclusive(bundle.InstallerPath, installer, 0o755); err != nil {
			return Bundle{}, err
		}
	}
	installerArtifact, err := artifactFor(bundle.InstallerPath, objectRoot+"install.sh")
	if err != nil {
		return Bundle{}, err
	}
	bundle.Release = computerport.ReleaseBinding{
		Version: config.Version, Target: target.Target, OSType: target.OSType,
		Architecture: target.Architecture, SigningKeyID: config.SigningKeyID,
		Manifest: manifestArtifact, Signature: signatureArtifact,
		Installer: installerArtifact, Program: program,
	}
	return bundle, nil
}

func targetDocumentFromRelease(release computerport.ReleaseBinding) targetDocument {
	return targetDocument{
		Target: release.Target, OSType: release.OSType, Architecture: release.Architecture,
		SigningKeyID: release.SigningKeyID,
		Manifest:     artifactToDocument(release.Manifest), Signature: artifactToDocument(release.Signature),
		Installer: artifactToDocument(release.Installer), Program: artifactToDocument(release.Program),
	}
}
