package api

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"

	"github.com/SpechtLabs/StaticPages/pkg/config"
	"github.com/SpechtLabs/StaticPages/pkg/s3_client"
	"github.com/gin-gonic/gin"
	"github.com/sierrasoftworks/humane-errors-go"
	"github.com/spechtlabs/go-otel-utils/otelzap"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.uber.org/zap"
)

const (
	staticPagesUploadFormatHeader = "X-StaticPages-Upload-Format"
	staticPagesTarGzipMediaType   = "application/vnd.lightvela.staticpages.archive.v1.tar+gzip"
)

// UploadHandler handles file upload requests, processes uploaded content, and returns a corresponding HTTP response.
func (r *RestApi) UploadHandler(ct *gin.Context) {
	ctx, span := r.tracer.Start(ct.Request.Context(), "restApi.UploadHandler")
	defer span.End()

	if ctx.Err() != nil {
		otelzap.L().Ctx(ctx).Warn("request context canceled")
		ct.AbortWithStatus(StatusRequestContextCanceled)
		return
	}

	// Get Repository Metadata claims (and verify authentication)
	metadata, herr := r.extractAndVerifyAuth(ctx, ct)
	if herr != nil {
		otelzap.L().WithError(herr).Ctx(ctx).Error("failed to extract or verify auth")
		ct.JSON(http.StatusForbidden, gin.H{"error": "invalid authorization header"})
		return
	}

	// Get the Page Configuration
	page, herr := r.extractPagesConfig(ctx, metadata.Repository())
	if herr != nil {
		otelzap.L().WithError(herr).Ctx(ctx).Error("repository not authorized", zap.String("repository", metadata.Repository()))
		ct.JSON(http.StatusForbidden, gin.H{"error": "repository not authorized"})
		return
	}

	// Parse uploaded files
	uploadPath, fileCount, size, herr := r.saveArtifactsToTemp(ctx, ct, metadata.SHA())
	if herr != nil {
		otelzap.L().WithError(herr).Ctx(ctx).Error("failed to save artifacts to temp folder", zap.String("commit_sha", metadata.SHA()))
		ct.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save artifacts"})
		return
	}
	defer func() {
		if err := os.RemoveAll(uploadPath); err != nil {
			otelzap.L().WithError(err).Ctx(ctx).Warn("failed to remove upload temp folder", zap.String("path", uploadPath))
		}
	}()

	span.SetAttributes(
		attribute.Int("file_count", fileCount),
		attribute.Int64("file_size", size),
	)

	s3client := s3_client.NewS3PageClient(page)
	herr = s3client.UploadFolder(ctx, uploadPath, filepath.Join(metadata.Repository(), metadata.SHA()))
	if herr != nil {
		otelzap.L().WithError(herr).Ctx(ctx).Error("failed to upload artifacts to storage backend")
		ct.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save artifacts"})
		return
	}

	pageIndex, err := s3client.DownloadPageIndex(ctx)
	if err != nil {
		otelzap.L().WithError(err).Ctx(ctx).Error("unable to get metadata", zap.String("domain", page.Domain.String()))
		ct.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update page metadata"})
		return
	}

	// Update our Page Metadata
	pageIndex[metadata.SHA()] = metadata

	span.SetAttributes(
		attribute.Int("index_size", len(pageIndex)),
	)

	herr = s3client.UploadPageIndex(ctx, pageIndex)
	if herr != nil {
		otelzap.L().WithError(herr).Ctx(ctx).Error("failed to update page metadata")
		ct.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update page metadata"})
		return
	}

	// Invalidate the cache immediately (useful if we're running "all in one")
	s3_client.InvalidatePageMetadata(page)

	span.SetStatus(codes.Ok, "")
	ct.JSON(http.StatusOK, gin.H{
		"status":      "upload successful",
		"file_count":  fileCount,
		"url":         fmt.Sprintf("https://%s", page.Domain.String()),
		"preview_url": getPreviewUrls(page, metadata),
	})
}

func (r *RestApi) saveArtifactsToTemp(ctx context.Context, ct *gin.Context, commitSha string) (string, int, int64, humane.Error) {
	ctx, span := r.tracer.Start(ctx, "restApi.saveArtifactsToTemp")
	defer span.End()

	uploadPath, err := os.MkdirTemp("", fmt.Sprintf("staticpages-%s-", sanitizeTempName(commitSha)))
	if err != nil {
		return "", 0, 0, humane.Wrap(err, "failed to create upload cache directory", "Make sure the upload cache directory is writable and try again.")
	}

	otelzap.L().Ctx(ctx).Debug("start saving artifacts", zap.String("path", uploadPath))

	if requestUsesTarGzipUpload(ct) {
		fileCount, size, herr := r.saveTarGzipArtifactsToTemp(ctx, ct.Request.Body, uploadPath)
		return uploadPath, fileCount, size, herr
	}

	fileCount, size, herr := r.saveMultipartArtifactsToTemp(ctx, ct, uploadPath)
	return uploadPath, fileCount, size, herr
}

func sanitizeTempName(value string) string {
	replacer := strings.NewReplacer("/", "-", "\\", "-", ":", "-", string(os.PathSeparator), "-")
	value = strings.Trim(replacer.Replace(value), "-")
	if value == "" {
		return "upload"
	}
	return value
}

func requestUsesTarGzipUpload(ct *gin.Context) bool {
	format := strings.ToLower(strings.TrimSpace(ct.GetHeader(staticPagesUploadFormatHeader)))
	if format == "tar.gz" || format == "tgz" {
		return true
	}

	contentType := strings.TrimSpace(ct.GetHeader("Content-Type"))
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		mediaType = strings.TrimSpace(strings.Split(contentType, ";")[0])
	}
	switch strings.ToLower(mediaType) {
	case staticPagesTarGzipMediaType, "application/gzip", "application/x-gzip", "application/tar+gzip", "application/x-tgz":
		return true
	default:
		return false
	}
}

func (r *RestApi) saveMultipartArtifactsToTemp(ctx context.Context, ct *gin.Context, uploadPath string) (int, int64, humane.Error) {
	ctx, span := r.tracer.Start(ctx, "restApi.saveMultipartArtifactsToTemp")
	defer span.End()

	form, err := ct.MultipartForm()
	if err != nil {
		otelzap.L().WithError(err).Ctx(ctx).Error("failed to parse multipart form")
		ct.JSON(http.StatusBadRequest, gin.H{"error": "invalid multipart form"})
		return 0, 0, humane.Wrap(err, "failed to parse multipart form", "Make sure the request is correctly formatted and try again.")
	}

	var (
		wg        sync.WaitGroup
		errOnce   sync.Once
		errResult humane.Error
		countMu   sync.Mutex
		fileCount int
		size      int64
	)

	for key, files := range form.File {
		relPath, ok := extractRelativePath(key)
		if !ok {
			continue
		}
		relPath, ok = cleanUploadRelativePath(relPath)
		if !ok {
			return 0, 0, humane.New("invalid upload path", "Uploaded file paths must be relative and must not contain parent directory traversal.")
		}

		for _, file := range files {
			wg.Add(1)
			file := file // capture loop var

			go func(relPath string) {
				defer wg.Done()

				dst, err := uploadDestination(uploadPath, relPath)
				if err != nil {
					errOnce.Do(func() {
						errResult = err
					})
					return
				}

				if err := os.MkdirAll(filepath.Dir(dst), 0o775); err != nil {
					errOnce.Do(func() {
						errResult = humane.Wrap(err, "failed to create upload cache directory", "Make sure the upload cache directory is writable and try again.")
					})
					return
				}

				if err := ct.SaveUploadedFile(file, dst); err != nil {
					errOnce.Do(func() {
						errResult = humane.Wrap(err, "failed to save file", "Make sure the upload cache directory is writable and try again.")
					})
					return
				}

				countMu.Lock()
				fileCount++
				size += file.Size
				countMu.Unlock()
			}(relPath)
		}
	}

	wg.Wait()
	if errResult != nil {
		return fileCount, size, errResult
	}
	if fileCount == 0 {
		return 0, 0, humane.New("no upload files found", "Upload at least one file in files[<relative-path>] multipart fields.")
	}
	return fileCount, size, nil
}

func (r *RestApi) saveTarGzipArtifactsToTemp(ctx context.Context, reader io.Reader, uploadPath string) (int, int64, humane.Error) {
	ctx, span := r.tracer.Start(ctx, "restApi.saveTarGzipArtifactsToTemp")
	defer span.End()

	gzipReader, err := gzip.NewReader(reader)
	if err != nil {
		return 0, 0, humane.Wrap(err, "failed to read tar.gz upload", "Upload a valid gzip-compressed tar archive.")
	}
	defer func() { _ = gzipReader.Close() }()

	tarReader := tar.NewReader(gzipReader)
	var fileCount int
	var size int64

	for {
		if ctx.Err() != nil {
			return fileCount, size, humane.Wrap(ctx.Err(), "request context canceled")
		}

		header, err := tarReader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fileCount, size, humane.Wrap(err, "failed to read tar archive", "Upload a valid tar.gz archive.")
		}

		relPath, ok := cleanUploadRelativePath(header.Name)
		if !ok {
			return fileCount, size, humane.New("invalid archive path", "Archive entries must be relative and must not contain parent directory traversal.")
		}

		dst, herr := uploadDestination(uploadPath, relPath)
		if herr != nil {
			return fileCount, size, herr
		}

		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(dst, 0o775); err != nil {
				return fileCount, size, humane.Wrap(err, "failed to create upload cache directory", "Make sure the upload cache directory is writable and try again.")
			}
		case tar.TypeReg, tar.TypeRegA:
			if err := os.MkdirAll(filepath.Dir(dst), 0o775); err != nil {
				return fileCount, size, humane.Wrap(err, "failed to create upload cache directory", "Make sure the upload cache directory is writable and try again.")
			}

			mode := header.FileInfo().Mode().Perm()
			if mode == 0 {
				mode = 0o664
			}
			out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
			if err != nil {
				return fileCount, size, humane.Wrap(err, "failed to save archive file", "Make sure the upload cache directory is writable and try again.")
			}
			written, copyErr := io.Copy(out, tarReader)
			closeErr := out.Close()
			if copyErr != nil {
				return fileCount, size, humane.Wrap(copyErr, "failed to extract archive file", "Upload a valid tar.gz archive.")
			}
			if closeErr != nil {
				return fileCount, size, humane.Wrap(closeErr, "failed to save archive file", "Make sure the upload cache directory is writable and try again.")
			}
			fileCount++
			size += written
		default:
			return fileCount, size, humane.New("unsupported archive entry", "Archive uploads may only contain regular files and directories.")
		}
	}

	if fileCount == 0 {
		return 0, 0, humane.New("no upload files found", "Upload a tar.gz archive containing at least one file.")
	}
	return fileCount, size, nil
}

func cleanUploadRelativePath(value string) (string, bool) {
	value = strings.ReplaceAll(value, "\\", "/")
	value = strings.TrimSpace(value)
	for strings.HasPrefix(value, "./") {
		value = strings.TrimPrefix(value, "./")
	}
	cleaned := path.Clean(value)
	if cleaned == "." || cleaned == "" || path.IsAbs(cleaned) || cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return "", false
	}
	return cleaned, true
}

func uploadDestination(baseDir string, relPath string) (string, humane.Error) {
	dst := filepath.Join(baseDir, filepath.FromSlash(relPath))
	cleanBase := filepath.Clean(baseDir)
	cleanDst := filepath.Clean(dst)
	if cleanDst != cleanBase && !strings.HasPrefix(cleanDst, cleanBase+string(os.PathSeparator)) {
		return "", humane.New("invalid upload path", "Uploaded file paths must stay inside the upload directory.")
	}
	return cleanDst, nil
}

func getPreviewUrls(page *config.Page, metadata *s3_client.PageIndexData) []string {
	previewUrls := make([]string, 0)
	if !page.Preview.Enabled {
		return previewUrls
	}

	if page.Preview.Branch && page.Git.MainBranch != metadata.Branch {
		previewUrls = append(previewUrls, fmt.Sprintf("https://%s.%s", metadata.Branch, page.Domain.String()))
	}

	if page.Preview.CommitSha {
		previewUrls = append(previewUrls, fmt.Sprintf("https://%s.%s", metadata.SHA(), page.Domain.String()))
	}

	if page.Preview.Environments {
		previewUrls = append(previewUrls, fmt.Sprintf("https://%s.%s", metadata.Environment, page.Domain.String()))
	}

	return previewUrls
}
