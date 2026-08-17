package selfupdate

import (
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

var ErrDownloadFailed = errors.New("Computer Update artifact 下载失败")

type VerifyReleaseFilesFunc func(VerifyReleaseFilesConfig) (VerifiedRelease, error)

type DownloadPreparerConfig struct {
	Root              string
	HTTPClient        *http.Client
	Now               func() time.Time
	ReleasePublicKeys map[string]ed25519.PublicKey
	Verify            VerifyReleaseFilesFunc
}

type DownloadPreparer struct {
	root        string
	http        *http.Client
	now         func() time.Time
	releaseKeys map[string]ed25519.PublicKey
	verify      VerifyReleaseFilesFunc
}

type candidateDocument struct {
	SchemaVersion int    `json:"schemaVersion"`
	Sequence      int64  `json:"sequence"`
	Version       string `json:"version"`
	Target        string `json:"target"`
	SigningKeyID  string `json:"signingKeyId"`
	ProgramSHA256 string `json:"programSHA256"`
	ProgramSize   int64  `json:"programSize"`
}

func NewDownloadPreparer(config DownloadPreparerConfig) (*DownloadPreparer, error) {
	if !cleanAbsolute(config.Root) || config.HTTPClient == nil || config.Now == nil ||
		len(config.ReleasePublicKeys) == 0 {
		return nil, ErrPollerInvalid
	}
	keys := make(map[string]ed25519.PublicKey, len(config.ReleasePublicKeys))
	for keyID, publicKey := range config.ReleasePublicKeys {
		if !keyIDPattern.MatchString(keyID) || len(publicKey) != ed25519.PublicKeySize {
			return nil, ErrPollerInvalid
		}
		keys[keyID] = append(ed25519.PublicKey(nil), publicKey...)
	}
	verify := config.Verify
	if verify == nil {
		verify = VerifyReleaseFiles
	}
	client := *config.HTTPClient
	if client.Timeout <= 0 {
		client.Timeout = 10 * time.Minute
	}
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}
	return &DownloadPreparer{
		root: config.Root, http: &client, now: config.Now,
		releaseKeys: keys, verify: verify,
	}, nil
}

func (preparer *DownloadPreparer) Prepare(
	ctx context.Context,
	channel VerifiedChannel,
) (Candidate, error) {
	if preparer == nil || ctx == nil || channel.Descriptor.Sequence < 1 ||
		!versionPattern.MatchString(channel.Descriptor.ExpectedVersion) ||
		!channel.Downloads.ExpiresAt.After(preparer.now().UTC()) {
		return Candidate{}, ErrPollerInvalid
	}
	if err := ensurePrivateStateRoot(preparer.root); err != nil {
		return Candidate{}, err
	}
	candidatesRoot := filepath.Join(preparer.root, "update", "candidates")
	downloadsRoot := filepath.Join(preparer.root, "update", "downloads")
	for _, directory := range []string{candidatesRoot, downloadsRoot} {
		if err := ensurePrivateDirectory(directory); err != nil {
			return Candidate{}, err
		}
	}
	destination := filepath.Join(
		candidatesRoot,
		fmt.Sprintf("%020d-%s", channel.Descriptor.Sequence, channel.Descriptor.ExpectedVersion),
	)
	if candidate, ok := preparer.openExisting(channel, destination); ok {
		return candidate, nil
	}
	temporary, err := os.MkdirTemp(downloadsRoot, ".candidate-*")
	if err != nil {
		return Candidate{}, ErrDownloadFailed
	}
	defer os.RemoveAll(temporary)
	if err := os.Chmod(temporary, 0o700); err != nil {
		return Candidate{}, ErrDownloadFailed
	}
	paths := candidatePaths(temporary)
	downloads := []struct {
		url     string
		path    string
		maximum int64
		mode    os.FileMode
		accept  string
	}{
		{channel.Downloads.CatalogURL, paths.Catalog, maximumReleaseCatalogBytes, 0o600, "application/json"},
		{channel.Downloads.ManifestURL, paths.Manifest, maximumManifestBytes, 0o600, "application/json"},
		{channel.Downloads.ManifestSignatureURL, paths.ManifestSignature, ed25519.SignatureSize, 0o600, "application/octet-stream"},
		{channel.Downloads.ProgramURL, paths.Program, maximumProgramBytes, 0o700, "application/octet-stream"},
	}
	for _, download := range downloads {
		if !channel.Downloads.ExpiresAt.After(preparer.now().UTC()) ||
			!validDownloadURL(download.url) ||
			preparer.download(ctx, download.url, download.path, download.maximum, download.mode, download.accept) != nil {
			return Candidate{}, ErrDownloadFailed
		}
	}
	release, err := preparer.verify(VerifyReleaseFilesConfig{
		Channel: channel, Paths: paths, ReleasePublicKeys: preparer.releaseKeys,
	})
	if err != nil {
		return Candidate{}, err
	}
	if release.Version != channel.Descriptor.ExpectedVersion || release.Target != channel.Descriptor.Target {
		return Candidate{}, ErrReleaseInvalid
	}
	metadata := candidateDocument{
		SchemaVersion: 1, Sequence: channel.Descriptor.Sequence,
		Version: release.Version, Target: release.Target, SigningKeyID: release.SigningKeyID,
		ProgramSHA256: hex.EncodeToString(release.ProgramSHA256[:]), ProgramSize: release.ProgramSize,
	}
	if err := writeCandidateDocument(filepath.Join(temporary, "candidate.json"), metadata); err != nil {
		return Candidate{}, err
	}
	if err := syncDirectory(temporary); err != nil {
		return Candidate{}, err
	}
	if err := os.Rename(temporary, destination); err != nil {
		if candidate, ok := preparer.openExisting(channel, destination); ok {
			return candidate, nil
		}
		return Candidate{}, ErrDownloadFailed
	}
	if err := syncDirectory(candidatesRoot); err != nil {
		return Candidate{}, err
	}
	return Candidate{
		Version: release.Version, Sequence: channel.Descriptor.Sequence,
		Directory: destination, Release: release,
	}, nil
}

func (preparer *DownloadPreparer) openExisting(
	channel VerifiedChannel,
	directory string,
) (Candidate, bool) {
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 ||
		info.Mode().Perm()&0o077 != 0 {
		return Candidate{}, false
	}
	raw, err := readSmallReleaseFile(filepath.Join(directory, "candidate.json"), 16*1024)
	if err != nil {
		return Candidate{}, false
	}
	var metadata candidateDocument
	if decodeExactJSON(raw, &metadata) != nil || metadata.SchemaVersion != 1 ||
		metadata.Sequence != channel.Descriptor.Sequence ||
		metadata.Version != channel.Descriptor.ExpectedVersion ||
		metadata.Target != channel.Descriptor.Target {
		return Candidate{}, false
	}
	release, err := preparer.verify(VerifyReleaseFilesConfig{
		Channel: channel, Paths: candidatePaths(directory), ReleasePublicKeys: preparer.releaseKeys,
	})
	if err != nil || metadata.SigningKeyID != release.SigningKeyID ||
		metadata.ProgramSHA256 != hex.EncodeToString(release.ProgramSHA256[:]) ||
		metadata.ProgramSize != release.ProgramSize {
		return Candidate{}, false
	}
	return Candidate{
		Version: release.Version, Sequence: metadata.Sequence,
		Directory: directory, Release: release,
	}, true
}

func (preparer *DownloadPreparer) download(
	ctx context.Context,
	location string,
	filename string,
	maximum int64,
	mode os.FileMode,
	accept string,
) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, location, nil)
	if err != nil {
		return ErrDownloadFailed
	}
	request.Header.Set("Accept", accept)
	request.Header.Set("Cache-Control", "no-store")
	response, err := preparer.http.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return ErrDownloadFailed
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.ContentLength > maximum {
		return ErrDownloadFailed
	}
	file, err := os.OpenFile(filename, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return ErrDownloadFailed
	}
	written, copyErr := io.Copy(file, io.LimitReader(response.Body, maximum+1))
	if copyErr == nil && written <= maximum {
		copyErr = file.Sync()
	}
	closeErr := file.Close()
	if copyErr != nil || closeErr != nil || written <= 0 || written > maximum {
		_ = os.Remove(filename)
		return ErrDownloadFailed
	}
	return nil
}

func candidatePaths(directory string) ReleasePaths {
	return ReleasePaths{
		Catalog:           filepath.Join(directory, "release.catalog.json"),
		Manifest:          filepath.Join(directory, "manifest.json"),
		ManifestSignature: filepath.Join(directory, "manifest.sig"),
		Program:           filepath.Join(directory, "vela-computer"),
	}
}

func writeCandidateDocument(filename string, value candidateDocument) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return ErrDownloadFailed
	}
	file, err := os.OpenFile(filename, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return ErrDownloadFailed
	}
	_, writeErr := file.Write(append(raw, '\n'))
	if writeErr == nil {
		writeErr = file.Sync()
	}
	closeErr := file.Close()
	if writeErr != nil || closeErr != nil {
		_ = os.Remove(filename)
		return ErrDownloadFailed
	}
	return nil
}

func ensurePrivateDirectory(directory string) error {
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return ErrDownloadFailed
	}
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 ||
		info.Mode().Perm()&0o077 != 0 {
		return ErrDownloadFailed
	}
	return nil
}

func syncDirectory(directory string) error {
	handle, err := os.Open(directory)
	if err != nil {
		return ErrDownloadFailed
	}
	defer handle.Close()
	if err := handle.Sync(); err != nil {
		return ErrDownloadFailed
	}
	return nil
}
