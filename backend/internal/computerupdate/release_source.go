package computerupdate

import (
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"

	"chatserver/internal/computerrelease"
	computerport "chatserver/internal/ports/computer"
)

type FilesystemReleaseSource struct {
	root          string
	publicKeyFile string
}

func NewFilesystemReleaseSource(
	root string,
	publicKeyFile string,
) (*FilesystemReleaseSource, error) {
	if !filepath.IsAbs(root) || filepath.Clean(root) != root ||
		!filepath.IsAbs(publicKeyFile) || filepath.Clean(publicKeyFile) != publicKeyFile {
		return nil, ErrInvalidServiceConfig
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 ||
		info.Mode().Perm()&0o022 != 0 {
		return nil, ErrInvalidServiceConfig
	}
	keyInfo, err := os.Lstat(publicKeyFile)
	if err != nil || !keyInfo.Mode().IsRegular() || keyInfo.Mode()&os.ModeSymlink != 0 {
		return nil, ErrInvalidServiceConfig
	}
	return &FilesystemReleaseSource{root: root, publicKeyFile: publicKeyFile}, nil
}

func (source *FilesystemReleaseSource) Open(
	ctx context.Context,
	version string,
) (ReleaseBundle, error) {
	if source == nil || ctx == nil || !versionPattern.MatchString(version) {
		return ReleaseBundle{}, ErrReleaseNotFound
	}
	if err := ctx.Err(); err != nil {
		return ReleaseBundle{}, err
	}
	entries, err := os.ReadDir(source.root)
	if err != nil {
		return ReleaseBundle{}, ErrUpdateStorage
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	var matched *computerrelease.ReleaseSetBundle
	for _, entry := range entries {
		if !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		bundle, err := computerrelease.OpenVerifiedReleaseSet(
			computerrelease.BundleVerificationConfig{
				Directory:     filepath.Join(source.root, entry.Name()),
				PublicKeyFile: source.publicKeyFile,
			},
		)
		if err != nil {
			return ReleaseBundle{}, ErrReleaseIncomplete
		}
		if bundle.ReleaseSet.Version != version {
			continue
		}
		if matched != nil {
			return ReleaseBundle{}, ErrReleaseIncomplete
		}
		copy := bundle
		matched = &copy
	}
	if matched == nil {
		return ReleaseBundle{}, ErrReleaseNotFound
	}
	catalog, err := artifactBindingForCatalog(matched.CatalogPath, version)
	if err != nil {
		return ReleaseBundle{}, ErrReleaseIncomplete
	}
	return ReleaseBundle{
		Version: matched.ReleaseSet.Version,
		Catalog: catalog,
		Releases: append(
			[]computerport.ReleaseBinding(nil),
			matched.ReleaseSet.Releases...,
		),
	}, nil
}

func artifactBindingForCatalog(
	filename string,
	version string,
) (computerport.ArtifactBinding, error) {
	file, err := os.Open(filename)
	if err != nil {
		return computerport.ArtifactBinding{}, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > 64*1024 {
		return computerport.ArtifactBinding{}, errors.New("catalog invalid")
	}
	digest := sha256.New()
	written, err := io.Copy(digest, file)
	if err != nil || written != info.Size() {
		return computerport.ArtifactBinding{}, errors.New("catalog digest invalid")
	}
	var hash [32]byte
	copy(hash[:], digest.Sum(nil))
	return computerport.ArtifactBinding{
		ObjectKey: "computer/releases/" + version + "/release.catalog.json",
		SHA256:    hash, Size: info.Size(),
	}, nil
}

var _ ReleaseSource = (*FilesystemReleaseSource)(nil)
