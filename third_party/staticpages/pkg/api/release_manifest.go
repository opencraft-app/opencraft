package api

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
)

const (
	releaseManifestVersion = 1
	maxReleasePackCount    = 1024
	maxReleaseFileCount    = 100000
	maxReleaseBytes        = int64(8 * 1024 * 1024 * 1024)
)

var (
	releasePackNamePattern = regexp.MustCompile(`^pack-[0-9]{4}-[a-f0-9]{16}\.tar\.gz$`)
	sha256Pattern          = regexp.MustCompile(`^[a-f0-9]{64}$`)
)

type ReleaseManifest struct {
	FormatVersion          int           `json:"format_version"`
	FileCount              int           `json:"file_count"`
	TotalUncompressedBytes int64         `json:"total_uncompressed_bytes"`
	Packs                  []ReleasePack `json:"packs"`
	Files                  []ReleaseFile `json:"files"`
}

type ReleasePack struct {
	Name                string `json:"name"`
	CompressedSize      int64  `json:"compressed_size"`
	SHA256              string `json:"sha256"`
	FileCount           int    `json:"file_count"`
	OversizedSingleFile bool   `json:"oversized_single_file"`
}

type ReleaseFile struct {
	Path        string `json:"path"`
	Size        int64  `json:"size"`
	SHA256      string `json:"sha256"`
	ContentType string `json:"content_type"`
	Pack        string `json:"pack"`
}

func validateReleaseManifest(manifest ReleaseManifest) error {
	if manifest.FormatVersion != releaseManifestVersion {
		return fmt.Errorf("unsupported release manifest version: %d", manifest.FormatVersion)
	}
	if len(manifest.Packs) == 0 || len(manifest.Packs) > maxReleasePackCount {
		return fmt.Errorf("invalid pack count: %d", len(manifest.Packs))
	}
	if manifest.FileCount != len(manifest.Files) || manifest.FileCount == 0 || manifest.FileCount > maxReleaseFileCount {
		return fmt.Errorf("invalid file count: declared=%d actual=%d", manifest.FileCount, len(manifest.Files))
	}
	if manifest.TotalUncompressedBytes < 0 || manifest.TotalUncompressedBytes > maxReleaseBytes {
		return fmt.Errorf("invalid total uncompressed size: %d", manifest.TotalUncompressedBytes)
	}

	packByName := make(map[string]ReleasePack, len(manifest.Packs))
	filesPerPack := make(map[string]int, len(manifest.Packs))
	for _, pack := range manifest.Packs {
		if !releasePackNamePattern.MatchString(pack.Name) {
			return fmt.Errorf("invalid pack name: %q", pack.Name)
		}
		if _, exists := packByName[pack.Name]; exists {
			return fmt.Errorf("duplicate pack name: %q", pack.Name)
		}
		if pack.CompressedSize <= 0 || pack.CompressedSize > maxReleaseBytes {
			return fmt.Errorf("invalid compressed size for pack %q: %d", pack.Name, pack.CompressedSize)
		}
		if !sha256Pattern.MatchString(pack.SHA256) {
			return fmt.Errorf("invalid pack checksum: %q", pack.Name)
		}
		if pack.FileCount <= 0 || pack.FileCount > maxReleaseFileCount {
			return fmt.Errorf("invalid file count for pack %q: %d", pack.Name, pack.FileCount)
		}
		if pack.OversizedSingleFile && pack.FileCount != 1 {
			return fmt.Errorf("oversized pack must contain one file: %q", pack.Name)
		}
		packByName[pack.Name] = pack
	}

	seenPaths := make(map[string]struct{}, len(manifest.Files))
	var totalSize int64
	for _, file := range manifest.Files {
		cleaned, ok := cleanUploadRelativePath(file.Path)
		if !ok || cleaned != file.Path {
			return fmt.Errorf("invalid file path: %q", file.Path)
		}
		if _, exists := seenPaths[file.Path]; exists {
			return fmt.Errorf("duplicate file path: %q", file.Path)
		}
		seenPaths[file.Path] = struct{}{}
		if file.Size < 0 || file.Size > maxReleaseBytes-totalSize {
			return fmt.Errorf("invalid file size: %q", file.Path)
		}
		if !sha256Pattern.MatchString(file.SHA256) {
			return fmt.Errorf("invalid file checksum: %q", file.Path)
		}
		if _, exists := packByName[file.Pack]; !exists {
			return fmt.Errorf("file references unknown pack: path=%q pack=%q", file.Path, file.Pack)
		}
		filesPerPack[file.Pack]++
		totalSize += file.Size
	}

	if totalSize != manifest.TotalUncompressedBytes {
		return fmt.Errorf("total uncompressed size mismatch: declared=%d actual=%d", manifest.TotalUncompressedBytes, totalSize)
	}
	for _, pack := range manifest.Packs {
		if filesPerPack[pack.Name] != pack.FileCount {
			return fmt.Errorf("pack file count mismatch: pack=%q declared=%d actual=%d", pack.Name, pack.FileCount, filesPerPack[pack.Name])
		}
	}
	return nil
}

type countingReader struct {
	reader io.Reader
	count  int64
}

func (r *countingReader) Read(buffer []byte) (int, error) {
	read, err := r.reader.Read(buffer)
	r.count += int64(read)
	return read, err
}

func extractReleasePacks(
	ctx context.Context,
	manifest ReleaseManifest,
	destination string,
	openPack func(context.Context, string) (io.ReadCloser, error),
) (int, int64, error) {
	if err := validateReleaseManifest(manifest); err != nil {
		return 0, 0, err
	}

	expectedByPack := make(map[string]map[string]ReleaseFile, len(manifest.Packs))
	for _, pack := range manifest.Packs {
		expectedByPack[pack.Name] = make(map[string]ReleaseFile, pack.FileCount)
	}
	for _, file := range manifest.Files {
		expectedByPack[file.Pack][file.Path] = file
	}

	var totalCount int
	var totalSize int64
	for _, pack := range manifest.Packs {
		if err := ctx.Err(); err != nil {
			return totalCount, totalSize, err
		}
		body, err := openPack(ctx, pack.Name)
		if err != nil {
			return totalCount, totalSize, fmt.Errorf("open pack %q: %w", pack.Name, err)
		}
		count, size, extractErr := extractReleasePack(ctx, pack, expectedByPack[pack.Name], destination, body)
		closeErr := body.Close()
		if extractErr != nil {
			return totalCount, totalSize, extractErr
		}
		if closeErr != nil {
			return totalCount, totalSize, fmt.Errorf("close pack %q: %w", pack.Name, closeErr)
		}
		totalCount += count
		totalSize += size
	}

	if totalCount != manifest.FileCount || totalSize != manifest.TotalUncompressedBytes {
		return totalCount, totalSize, fmt.Errorf(
			"release totals mismatch: files=%d/%d bytes=%d/%d",
			totalCount,
			manifest.FileCount,
			totalSize,
			manifest.TotalUncompressedBytes,
		)
	}
	return totalCount, totalSize, nil
}

func extractReleasePack(
	ctx context.Context,
	pack ReleasePack,
	expected map[string]ReleaseFile,
	destination string,
	body io.Reader,
) (int, int64, error) {
	digest := sha256.New()
	compressed := &countingReader{reader: io.TeeReader(body, digest)}
	gzipReader, err := gzip.NewReader(compressed)
	if err != nil {
		return 0, 0, fmt.Errorf("read pack %q: %w", pack.Name, err)
	}
	archive := tar.NewReader(gzipReader)
	seen := make(map[string]struct{}, len(expected))
	var count int
	var size int64

	for {
		if err := ctx.Err(); err != nil {
			_ = gzipReader.Close()
			return count, size, err
		}
		header, err := archive.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			_ = gzipReader.Close()
			return count, size, fmt.Errorf("read archive in pack %q: %w", pack.Name, err)
		}
		if header.Typeflag != tar.TypeReg && header.Typeflag != tar.TypeRegA {
			_ = gzipReader.Close()
			return count, size, fmt.Errorf("unsupported archive entry in pack %q: %q", pack.Name, header.Name)
		}
		cleaned, ok := cleanUploadRelativePath(header.Name)
		if !ok || cleaned != header.Name {
			_ = gzipReader.Close()
			return count, size, fmt.Errorf("invalid archive path in pack %q: %q", pack.Name, header.Name)
		}
		file, exists := expected[cleaned]
		if !exists {
			_ = gzipReader.Close()
			return count, size, fmt.Errorf("undeclared file in pack %q: %q", pack.Name, cleaned)
		}
		if _, duplicate := seen[cleaned]; duplicate {
			_ = gzipReader.Close()
			return count, size, fmt.Errorf("duplicate file in pack %q: %q", pack.Name, cleaned)
		}
		if header.Size != file.Size {
			_ = gzipReader.Close()
			return count, size, fmt.Errorf("file size mismatch in pack %q: %q", pack.Name, cleaned)
		}

		destinationPath, pathErr := uploadDestination(destination, cleaned)
		if pathErr != nil {
			_ = gzipReader.Close()
			return count, size, pathErr
		}
		if err := os.MkdirAll(filepath.Dir(destinationPath), 0o775); err != nil {
			_ = gzipReader.Close()
			return count, size, fmt.Errorf("create release directory: %w", err)
		}
		output, err := os.OpenFile(destinationPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o664)
		if err != nil {
			_ = gzipReader.Close()
			return count, size, fmt.Errorf("create release file %q: %w", cleaned, err)
		}
		fileDigest := sha256.New()
		written, copyErr := io.Copy(io.MultiWriter(output, fileDigest), archive)
		closeErr := output.Close()
		if copyErr != nil {
			_ = gzipReader.Close()
			return count, size, fmt.Errorf("extract release file %q: %w", cleaned, copyErr)
		}
		if closeErr != nil {
			_ = gzipReader.Close()
			return count, size, fmt.Errorf("save release file %q: %w", cleaned, closeErr)
		}
		if written != file.Size || hex.EncodeToString(fileDigest.Sum(nil)) != file.SHA256 {
			_ = gzipReader.Close()
			return count, size, fmt.Errorf("file checksum mismatch in pack %q: %q", pack.Name, cleaned)
		}
		seen[cleaned] = struct{}{}
		count++
		size += written
	}

	if err := gzipReader.Close(); err != nil {
		return count, size, fmt.Errorf("close gzip pack %q: %w", pack.Name, err)
	}
	if _, err := io.Copy(io.Discard, compressed); err != nil {
		return count, size, fmt.Errorf("finish pack %q: %w", pack.Name, err)
	}
	if compressed.count != pack.CompressedSize {
		return count, size, fmt.Errorf("pack size mismatch: %q", pack.Name)
	}
	if hex.EncodeToString(digest.Sum(nil)) != pack.SHA256 {
		return count, size, fmt.Errorf("pack checksum mismatch: %q", pack.Name)
	}
	if count != pack.FileCount || count != len(expected) {
		return count, size, fmt.Errorf("pack file count mismatch after extraction: %q", pack.Name)
	}
	return count, size, nil
}
