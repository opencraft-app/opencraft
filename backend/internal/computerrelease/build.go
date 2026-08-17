package computerrelease

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	computerport "chatserver/internal/ports/computer"
)

const manifestSchema = "agent-network-computer-release/v1"

type BuildConfig struct {
	Version         string
	Target          string
	OSType          string
	Architecture    string
	SigningKeyID    string
	PrivateKey      ed25519.PrivateKey
	ProgramPath     string
	InstallerPath   string
	OutputDirectory string
}

type Bundle struct {
	Release       computerport.ReleaseBinding
	ProgramPath   string
	InstallerPath string
	ManifestPath  string
	SignaturePath string
	CatalogPath   string
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

func Build(config BuildConfig) (Bundle, error) {
	if !validComponent(config.Version) || !validComponent(config.Target) ||
		!validComponent(config.OSType) || !validComponent(config.Architecture) ||
		!validComponent(config.SigningKeyID) || config.Target != (catalogDocument{
		OSType: config.OSType, Architecture: config.Architecture,
	}).OSTypeTarget() || len(config.PrivateKey) != ed25519.PrivateKeySize ||
		!filepath.IsAbs(config.ProgramPath) ||
		(config.InstallerPath != "" && !filepath.IsAbs(config.InstallerPath)) ||
		!filepath.IsAbs(config.OutputDirectory) {
		return Bundle{}, errors.New("Computer release build 配置无效")
	}
	if _, err := os.Lstat(config.OutputDirectory); !errors.Is(err, os.ErrNotExist) {
		return Bundle{}, errors.New("Computer release 输出目录已存在")
	}
	if err := os.MkdirAll(config.OutputDirectory, 0o700); err != nil {
		return Bundle{}, errors.New("无法创建 Computer release 输出目录")
	}
	complete := false
	defer func() {
		if !complete {
			_ = os.RemoveAll(config.OutputDirectory)
		}
	}()
	targetDirectory := filepath.Join(config.OutputDirectory, config.Target)
	if err := os.Mkdir(targetDirectory, 0o700); err != nil {
		return Bundle{}, err
	}
	bundle := Bundle{
		ProgramPath:   filepath.Join(targetDirectory, "vela-computer"),
		InstallerPath: filepath.Join(targetDirectory, "install.sh"),
		ManifestPath:  filepath.Join(config.OutputDirectory, "manifest.json"),
		SignaturePath: filepath.Join(config.OutputDirectory, "manifest.sig"),
		CatalogPath:   filepath.Join(config.OutputDirectory, "release.catalog.json"),
	}
	if err := copyExclusive(config.ProgramPath, bundle.ProgramPath, 0o755); err != nil {
		return Bundle{}, err
	}
	root := "computer/releases/" + config.Version + "/"
	program, err := artifactFor(bundle.ProgramPath, root+config.Target+"/vela-computer")
	if err != nil {
		return Bundle{}, err
	}
	manifest := manifestDocument{
		Schema: manifestSchema, Version: config.Version, Target: config.Target,
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
	signatureBytes := ed25519.Sign(config.PrivateKey, manifestBytes)
	if err := writeExclusive(bundle.SignaturePath, signatureBytes, 0o644); err != nil {
		return Bundle{}, err
	}
	manifestArtifact, err := artifactFor(bundle.ManifestPath, root+"manifest.json")
	if err != nil {
		return Bundle{}, err
	}
	signatureArtifact, err := artifactFor(bundle.SignaturePath, root+"manifest.sig")
	if err != nil {
		return Bundle{}, err
	}
	if config.InstallerPath != "" {
		if err := copyExclusive(config.InstallerPath, bundle.InstallerPath, 0o755); err != nil {
			return Bundle{}, err
		}
	} else {
		installerBytes, err := renderInstaller(
			config,
			program,
			manifestArtifact,
			signatureArtifact,
		)
		if err != nil {
			return Bundle{}, err
		}
		if err := writeExclusive(bundle.InstallerPath, installerBytes, 0o755); err != nil {
			return Bundle{}, err
		}
	}
	installer, err := artifactFor(bundle.InstallerPath, root+config.Target+"/install.sh")
	if err != nil {
		return Bundle{}, err
	}
	bundle.Release = computerport.ReleaseBinding{
		Version: config.Version, Target: config.Target, OSType: config.OSType,
		Architecture: config.Architecture, SigningKeyID: config.SigningKeyID,
		Manifest: manifestArtifact, Signature: signatureArtifact,
		Installer: installer, Program: program,
	}
	catalogBytes, err := json.MarshalIndent(catalogFromRelease(bundle.Release), "", "  ")
	if err != nil {
		return Bundle{}, err
	}
	catalogBytes = append(catalogBytes, '\n')
	if err := writeExclusive(bundle.CatalogPath, catalogBytes, 0o644); err != nil {
		return Bundle{}, err
	}
	complete = true
	return bundle, nil
}

func renderInstaller(
	config BuildConfig,
	program computerport.ArtifactBinding,
	manifest computerport.ArtifactBinding,
	signature computerport.ArtifactBinding,
) ([]byte, error) {
	publicKey, ok := config.PrivateKey.Public().(ed25519.PublicKey)
	if !ok || len(publicKey) != ed25519.PublicKeySize {
		return nil, errors.New("Computer release Ed25519 公钥无效")
	}
	verifySHA256 := `/usr/bin/printf '%s  %s\n' "$expected" "$file" | /usr/bin/shasum -a 256 -c - >/dev/null`
	programSizeCheck := `[ "$(/usr/bin/stat -f %z "$work/vela-computer")" = '@@PROGRAM_SIZE@@' ]`
	if config.OSType == "linux" {
		verifySHA256 = `/usr/bin/printf '%s  %s\n' "$expected" "$file" | /usr/bin/sha256sum -c - >/dev/null`
		programSizeCheck = `[ "$(/usr/bin/stat -c %s "$work/vela-computer")" = '@@PROGRAM_SIZE@@' ]`
	}
	replacements := strings.NewReplacer(
		"@@VERSION@@", config.Version,
		"@@TARGET@@", config.Target,
		"@@PUBLIC_KEY@@", base64.RawStdEncoding.EncodeToString(publicKey),
		"@@PROGRAM_HASH@@", hex.EncodeToString(program.SHA256[:]),
		"@@PROGRAM_SIZE@@", fmtInt64(program.Size),
		"@@MANIFEST_HASH@@", hex.EncodeToString(manifest.SHA256[:]),
		"@@SIGNATURE_HASH@@", hex.EncodeToString(signature.SHA256[:]),
		"@@VERIFY_SHA256@@", verifySHA256,
		"@@PROGRAM_SIZE_CHECK@@", programSizeCheck,
	)
	return []byte(replacements.Replace(installerTemplate)), nil
}

func fmtInt64(value int64) string {
	return strconv.FormatInt(value, 10)
}

const installerTemplate = `#!/bin/sh
set -eu
umask 077

token_file=
platform_url=
allow_insecure_platform_http=0
install_http_arg=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --token-file) token_file=${2-}; shift 2 ;;
    --platform-url) platform_url=${2-}; shift 2 ;;
    --allow-insecure-platform-http)
      allow_insecure_platform_http=1
      install_http_arg=--allow-insecure-platform-http
      shift
      ;;
    *) /usr/bin/printf '%s\n' '安装参数无效' >&2; exit 64 ;;
  esac
done

case "$token_file" in /*) ;; *) /usr/bin/printf '%s\n' '接入凭证文件无效' >&2; exit 64 ;; esac
case "$platform_url" in
  https://*) [ "$allow_insecure_platform_http" = 0 ] || { /usr/bin/printf '%s\n' '平台地址无效' >&2; exit 64; } ;;
  http://*) [ "$allow_insecure_platform_http" = 1 ] || { /usr/bin/printf '%s\n' '平台地址无效' >&2; exit 64; } ;;
  *) /usr/bin/printf '%s\n' '平台地址无效' >&2; exit 64 ;;
esac
case "${platform_url#*://}" in
  ''|*/*|*@*|*'?'*|*'#'*|*' '*|*'\t'*|*'\r'*|*'\n'*)
    /usr/bin/printf '%s\n' '平台地址无效' >&2
    exit 64
    ;;
esac
[ -f "$token_file" ] || { /usr/bin/printf '%s\n' '接入凭证文件不存在' >&2; exit 66; }

tmp_root=${TMPDIR:-/tmp}
tmp_root=${tmp_root%/}
[ -n "$tmp_root" ] || tmp_root=/tmp
work=$(/usr/bin/mktemp -d "$tmp_root/an-computer-install.XXXXXX") || exit 1
trap '/bin/rm -rf "$work"' EXIT HUP INT TERM
artifact_base=${platform_url%/}/v1/computer-artifacts/@@VERSION@@/@@TARGET@@
allowed_protocols='=https'
if [ "$allow_insecure_platform_http" = 1 ]; then
  allowed_protocols='=http,https'
fi

fetch() {
  artifact_name=$1
  destination=$2
  token=$(/bin/cat "$token_file") || exit 1
  /usr/bin/printf '%s\n' \
    'fail' 'silent' 'show-error' 'location' 'max-redirs = 1' \
    "proto = \"${allowed_protocols}\"" 'proto-redir = "=https"' \
    "header = \"Authorization: Enrollment ${token}\"" \
    "url = \"${artifact_base}/${artifact_name}\"" >"$work/curl.conf"
  unset token
  /usr/bin/env -i PATH=/usr/bin:/bin HTTPS_PROXY="${HTTPS_PROXY-}" NO_PROXY="${NO_PROXY-}" \
    /usr/bin/curl -q --config "$work/curl.conf" --output "$destination"
  : >"$work/curl.conf"
}

verify_sha256() {
  expected=$1
  file=$2
  @@VERIFY_SHA256@@
}

fetch manifest.json "$work/manifest.json"
fetch manifest.sig "$work/manifest.sig"
fetch vela-computer "$work/vela-computer"
verify_sha256 '@@MANIFEST_HASH@@' "$work/manifest.json"
verify_sha256 '@@SIGNATURE_HASH@@' "$work/manifest.sig"
verify_sha256 '@@PROGRAM_HASH@@' "$work/vela-computer"
@@PROGRAM_SIZE_CHECK@@ || {
  /usr/bin/printf '%s\n' '程序大小校验失败' >&2
  exit 65
}
/bin/chmod 0700 "$work/vela-computer"
"$work/vela-computer" install \
  --platform-url "$platform_url" \
  --token-file "$token_file" \
  --manifest-file "$work/manifest.json" \
  --signature-file "$work/manifest.sig" \
  --signing-public-key '@@PUBLIC_KEY@@' \
  --release-version '@@VERSION@@' \
  --target '@@TARGET@@' \
  $install_http_arg
`

type ObjectPublisher interface {
	PublishFile(context.Context, string, string, string, [32]byte, int64) error
}

func Publish(ctx context.Context, publisher ObjectPublisher, bundle Bundle) error {
	if ctx == nil || publisher == nil {
		return errors.New("Computer release publisher 无效")
	}
	steps := []struct {
		artifact computerport.ArtifactBinding
		path     string
		typeName string
	}{
		{bundle.Release.Program, bundle.ProgramPath, "application/octet-stream"},
		{bundle.Release.Installer, bundle.InstallerPath, "text/x-shellscript"},
		{bundle.Release.Manifest, bundle.ManifestPath, "application/json"},
		{bundle.Release.Signature, bundle.SignaturePath, "application/octet-stream"},
	}
	for _, step := range steps {
		if err := publisher.PublishFile(
			ctx, step.artifact.ObjectKey, step.path, step.typeName,
			step.artifact.SHA256, step.artifact.Size,
		); err != nil {
			return err
		}
	}
	return nil
}

func PublishReleaseSet(ctx context.Context, publisher ObjectPublisher, bundle ReleaseSetBundle) error {
	if len(bundle.Bundles) != 2 {
		return errors.New("Computer release set publisher 无效")
	}
	for _, target := range bundle.Bundles {
		if err := Publish(ctx, publisher, target); err != nil {
			return err
		}
	}
	return nil
}

func catalogFromRelease(release computerport.ReleaseBinding) catalogDocument {
	return catalogDocument{
		Version: release.Version, Target: release.Target, OSType: release.OSType,
		Architecture: release.Architecture, SigningKeyID: release.SigningKeyID,
		Manifest:  artifactToDocument(release.Manifest),
		Signature: artifactToDocument(release.Signature),
		Installer: artifactToDocument(release.Installer),
		Program:   artifactToDocument(release.Program),
	}
}

func artifactToDocument(artifact computerport.ArtifactBinding) artifactDocument {
	return artifactDocument{
		ObjectKey: artifact.ObjectKey,
		SHA256:    hex.EncodeToString(artifact.SHA256[:]),
		Size:      artifact.Size,
	}
}

func artifactFor(filename string, objectKey string) (computerport.ArtifactBinding, error) {
	file, err := os.Open(filename)
	if err != nil {
		return computerport.ArtifactBinding{}, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 {
		return computerport.ArtifactBinding{}, errors.New("Computer release artifact 文件无效")
	}
	digest := sha256.New()
	written, err := io.Copy(digest, file)
	if err != nil || written != info.Size() {
		return computerport.ArtifactBinding{}, errors.New("无法计算 Computer release artifact 摘要")
	}
	var hash [32]byte
	copy(hash[:], digest.Sum(nil))
	return computerport.ArtifactBinding{ObjectKey: objectKey, SHA256: hash, Size: info.Size()}, nil
}

func copyExclusive(source string, target string, mode os.FileMode) error {
	sourceFile, err := os.Open(source)
	if err != nil {
		return err
	}
	defer sourceFile.Close()
	info, err := sourceFile.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 {
		return errors.New("Computer release 输入文件无效")
	}
	targetFile, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	ok := false
	defer func() {
		_ = targetFile.Close()
		if !ok {
			_ = os.Remove(target)
		}
	}()
	if _, err := io.Copy(targetFile, sourceFile); err != nil {
		return err
	}
	if err := targetFile.Sync(); err != nil || targetFile.Close() != nil {
		return errors.New("无法持久化 Computer release 文件")
	}
	ok = true
	return nil
}

func writeExclusive(filename string, content []byte, mode os.FileMode) error {
	file, err := os.OpenFile(filename, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	ok := false
	defer func() {
		_ = file.Close()
		if !ok {
			_ = os.Remove(filename)
		}
	}()
	if _, err := file.Write(content); err != nil {
		return err
	}
	if err := file.Sync(); err != nil || file.Close() != nil {
		return errors.New("无法持久化 Computer release 文件")
	}
	ok = true
	return nil
}
