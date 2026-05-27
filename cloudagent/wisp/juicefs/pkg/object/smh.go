package object

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type smh struct {
	DefaultObjectStorage
	endpoint    *url.URL
	libraryID   string
	spaceID     string
	accessToken string
	permanent   bool
	dirMu       sync.Mutex
	dirCache    map[string]struct{}
	dirInflight map[string]*smhDirEnsureFlight
}

type smhDirEnsureFlight struct {
	done chan struct{}
	err  error
}

type smhFileInfo struct {
	Path             []string          `json:"path"`
	Name             string            `json:"name"`
	Type             string            `json:"type"`
	CreationTime     string            `json:"creationTime"`
	ModificationTime string            `json:"modificationTime"`
	Size             string            `json:"size"`
	ETag             string            `json:"eTag"`
	CRC64            string            `json:"crc64"`
	ContentType      string            `json:"contentType"`
	MetaData         map[string]string `json:"metaData"`
}

type smhListResponse struct {
	NextMarker any           `json:"nextMarker"`
	Contents   []smhFileInfo `json:"contents"`
}

type smhBeginSimpleUploadResponse struct {
	Domain     string            `json:"domain"`
	Path       string            `json:"path"`
	Headers    map[string]string `json:"headers"`
	Form       map[string]string `json:"form"`
	ConfirmKey string            `json:"confirmKey"`
	Expiration string            `json:"expiration"`
}

type smhBeginMultipartUploadResponse struct {
	Domain     string            `json:"domain"`
	Path       string            `json:"path"`
	UploadID   string            `json:"uploadId"`
	Headers    map[string]string `json:"headers"`
	ConfirmKey string            `json:"confirmKey"`
	Expiration string            `json:"expiration"`
}

type smhUploadTaskStatus struct {
	Confirmed      bool                         `json:"confirmed"`
	Path           []string                     `json:"path"`
	ConflictPolicy string                       `json:"conflictResolutionStrategy"`
	Force          bool                         `json:"force"`
	UploadID       string                       `json:"uploadId"`
	Parts          []smhUploadTaskPart          `json:"parts"`
	UploadPartInfo *smhBeginMultipartUploadInfo `json:"uploadPartInfo"`
}

type smhUploadTaskPart struct {
	PartNumber   int    `json:"PartNumber"`
	LastModified string `json:"LastModified"`
	ETag         string `json:"ETag"`
	Size         int    `json:"Size"`
}

type smhBeginMultipartUploadInfo struct {
	Domain     string            `json:"domain"`
	Path       string            `json:"path"`
	UploadID   string            `json:"uploadId"`
	Headers    map[string]string `json:"headers"`
	Expiration string            `json:"expiration"`
}

type smhCopyRequest struct {
	CopyFrom string `json:"copyFrom"`
}

type smhUploadSession struct {
	Kind       string            `json:"kind"`
	Key        string            `json:"key"`
	Domain     string            `json:"domain"`
	Path       string            `json:"path"`
	UploadID   string            `json:"uploadId,omitempty"`
	Headers    map[string]string `json:"headers,omitempty"`
	ConfirmKey string            `json:"confirmKey"`
	Expiration string            `json:"expiration,omitempty"`
}

func (s *smh) String() string {
	return fmt.Sprintf("smh://%s/%s/%s", s.endpoint.Host, s.libraryID, s.spaceID)
}

func (s *smh) Limits() Limits {
	return Limits{
		IsSupportMultipartUpload: true,
		IsSupportUploadPartCopy:  false,
		MinPartSize:              1 << 20,
		MaxPartSize:              5 << 30,
		MaxPartCount:             10000,
	}
}

func (s *smh) Head(ctx context.Context, key string) (Object, error) {
	info, err := s.lookup(ctx, key)
	if err != nil {
		return nil, err
	}
	return toSMHObject(key, info)
}

func (s *smh) Get(ctx context.Context, key string, off, limit int64, getters ...AttrGetter) (io.ReadCloser, error) {
	headers := map[string]string{}
	if off > 0 || limit > 0 {
		headers["Range"] = getRange(off, limit)
	}
	resp, err := s.apiRequest(ctx, http.MethodGet, s.fileAPIPath(key), nil, headers)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == http.StatusNotFound {
		defer cleanup(resp)
		return nil, os.ErrNotExist
	}
	if resp.StatusCode == http.StatusRequestedRangeNotSatisfiable {
		defer cleanup(resp)
		return io.NopCloser(bytes.NewReader(nil)), nil
	}
	if err := checkGetStatus(resp.StatusCode, len(headers) > 0); err != nil {
		defer cleanup(resp)
		return nil, err
	}
	return resp.Body, nil
}

func (s *smh) Put(ctx context.Context, key string, in io.Reader, getters ...AttrGetter) error {
	if strings.HasSuffix(key, "/") {
		return s.ensureDir(ctx, strings.TrimSuffix(key, "/"))
	}
	if err := s.ensureParentDir(ctx, key); err != nil {
		return err
	}
	payload := in
	size := int64(-1)
	if rs, ok := in.(io.ReadSeeker); ok {
		var err error
		size, err = remainingReaderSize(rs)
		if err != nil {
			return err
		}
		payload = rs
	}
	upload, err := s.beginSimpleUpload(ctx, key, size)
	if err != nil {
		return err
	}
	if len(upload.Form) > 0 {
		if err := s.uploadFormToCOS(ctx, upload.Domain, upload.Path, upload.Form, payload); err != nil {
			return err
		}
	} else {
		if err := s.uploadToCOS(ctx, upload.Domain, upload.Path, "", upload.Headers, payload, size); err != nil {
			return err
		}
	}
	return s.confirmUpload(ctx, upload.ConfirmKey)
}

func (s *smh) Copy(ctx context.Context, dst, src string) error {
	if strings.HasSuffix(src, "/") || strings.HasSuffix(dst, "/") {
		return notSupported
	}
	if err := s.ensureParentDir(ctx, dst); err != nil {
		return err
	}
	body, err := json.Marshal(smhCopyRequest{CopyFrom: normalizeSMHKey(src)})
	if err != nil {
		return err
	}
	resp, err := s.apiRequest(ctx, http.MethodPut, s.fileAPIPath(dst), bytes.NewReader(body), map[string]string{"Content-Type": "application/json"})
	if err != nil {
		return err
	}
	defer cleanup(resp)
	if resp.StatusCode != http.StatusOK {
		return parseSMHError(resp)
	}
	return nil
}

func (s *smh) Delete(ctx context.Context, key string, getters ...AttrGetter) error {
	target := normalizeSMHKey(key)
	if target == "" {
		return nil
	}
	path := s.fileAPIPath(target)
	if strings.HasSuffix(key, "/") {
		path = s.directoryAPIPath(strings.TrimSuffix(target, "/"))
	}
	q := url.Values{}
	if s.permanent {
		q.Set("permanent", "1")
	}
	resp, err := s.apiRequest(ctx, http.MethodDelete, path+"?"+q.Encode(), nil, nil)
	if err != nil {
		return err
	}
	defer cleanup(resp)
	switch resp.StatusCode {
	case http.StatusOK, http.StatusNoContent:
		if strings.HasSuffix(key, "/") {
			s.invalidateDirCache(target)
		}
		return nil
	case http.StatusNotFound:
		if strings.HasSuffix(key, "/") {
			s.invalidateDirCache(target)
		}
		return nil
	default:
		return parseSMHError(resp)
	}
}

func (s *smh) List(ctx context.Context, prefix, startAfter, token, delimiter string, limit int64, followLink bool) ([]Object, bool, string, error) {
	if delimiter == "" {
		return s.listRecursive(ctx, prefix, startAfter, limit)
	}
	if delimiter != "/" {
		return nil, false, "", notSupported
	}
	return s.listOneLevel(ctx, prefix, startAfter, limit)
}

func (s *smh) CreateMultipartUpload(ctx context.Context, key string) (*MultipartUpload, error) {
	if strings.HasSuffix(key, "/") {
		return nil, notSupported
	}
	if err := s.ensureParentDir(ctx, key); err != nil {
		return nil, err
	}
	session, err := s.beginMultipartUpload(ctx, key)
	if err != nil {
		return nil, err
	}
	encoded, err := encodeSMHUploadSession(session)
	if err != nil {
		return nil, err
	}
	return &MultipartUpload{UploadID: encoded, MinPartSize: 1 << 20, MaxCount: 10000}, nil
}

func (s *smh) UploadPart(ctx context.Context, key string, uploadID string, num int, body []byte) (*Part, error) {
	session, err := decodeSMHUploadSession(uploadID)
	if err != nil {
		return nil, err
	}
	if normalizeSMHKey(key) != normalizeSMHKey(session.Key) {
		return nil, fmt.Errorf("upload session key mismatch")
	}
	if err := s.uploadToCOS(ctx, session.Domain, session.Path, session.UploadID, session.Headers, bytes.NewReader(body), int64(len(body)), num); err != nil {
		return nil, err
	}
	return &Part{Num: num, ETag: fmt.Sprintf("smh-part-%d", num), Size: len(body)}, nil
}

func (s *smh) CompleteUpload(ctx context.Context, key string, uploadID string, parts []*Part) error {
	session, err := decodeSMHUploadSession(uploadID)
	if err != nil {
		return err
	}
	if normalizeSMHKey(key) != normalizeSMHKey(session.Key) {
		return fmt.Errorf("upload session key mismatch")
	}
	return s.confirmUpload(ctx, session.ConfirmKey)
}

func (s *smh) RenewUpload(ctx context.Context, uploadID string) (string, error) {
	session, err := decodeSMHUploadSession(uploadID)
	if err != nil {
		return "", err
	}
	resp, err := s.apiRequest(ctx, http.MethodPost, fmt.Sprintf("/api/v1/file/%s/%s/%s?renew", url.PathEscape(s.libraryID), url.PathEscape(s.spaceID), url.PathEscape(session.ConfirmKey)), nil, nil)
	if err != nil {
		return "", err
	}
	defer cleanup(resp)
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return "", parseSMHError(resp)
	}
	var out smhBeginMultipartUploadResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	session.Domain = out.Domain
	session.Path = out.Path
	session.UploadID = out.UploadID
	session.Headers = out.Headers
	session.Expiration = out.Expiration
	return encodeSMHUploadSession(session)
}

func (s *smh) UploadStatus(ctx context.Context, uploadID string) (smhUploadTaskStatus, error) {
	session, err := decodeSMHUploadSession(uploadID)
	if err != nil {
		return smhUploadTaskStatus{}, err
	}
	resp, err := s.apiRequest(ctx, http.MethodGet, fmt.Sprintf("/api/v1/file/%s/%s/%s?upload", url.PathEscape(s.libraryID), url.PathEscape(s.spaceID), url.PathEscape(session.ConfirmKey)), nil, nil)
	if err != nil {
		return smhUploadTaskStatus{}, err
	}
	defer cleanup(resp)
	if resp.StatusCode != http.StatusOK {
		return smhUploadTaskStatus{}, parseSMHError(resp)
	}
	var out smhUploadTaskStatus
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return smhUploadTaskStatus{}, err
	}
	return out, nil
}

func (s *smh) AbortUpload(ctx context.Context, key string, uploadID string) {
	session, err := decodeSMHUploadSession(uploadID)
	if err != nil {
		return
	}
	resp, err := s.apiRequest(ctx, http.MethodDelete, fmt.Sprintf("/api/v1/file/%s/%s/%s?upload", url.PathEscape(s.libraryID), url.PathEscape(s.spaceID), url.PathEscape(session.ConfirmKey)), nil, nil)
	if err != nil {
		return
	}
	defer cleanup(resp)
}

func (s *smh) ListUploads(ctx context.Context, marker string) ([]*PendingPart, string, error) {
	return nil, "", nil
}

func (s *smh) ensureParentDir(ctx context.Context, key string) error {
	parent := path.Dir("/" + normalizeSMHKey(key))
	parent = strings.Trim(strings.TrimSpace(parent), "/")
	if parent == "" || parent == "." {
		return nil
	}
	return s.ensureDir(ctx, parent)
}

func (s *smh) ensureDir(ctx context.Context, dir string) error {
	dir = strings.Trim(strings.TrimSpace(dir), "/")
	if dir == "" {
		return nil
	}
	flight, leader := s.beginEnsureDir(dir)
	if !leader {
		if flight == nil {
			return nil
		}
		select {
		case <-flight.done:
			return flight.err
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	err := s.ensureDirRemote(ctx, dir)
	s.finishEnsureDir(dir, flight, err)
	return err
}

func (s *smh) ensureDirRemote(ctx context.Context, dir string) error {
	resp, err := s.apiRequest(ctx, http.MethodPut, s.directoryAPIPath(dir), nil, nil)
	if err != nil {
		return err
	}
	defer cleanup(resp)
	if resp.StatusCode == http.StatusCreated || resp.StatusCode == http.StatusOK {
		return nil
	}
	if resp.StatusCode == http.StatusConflict {
		info, err := s.lookup(ctx, strings.TrimSuffix(dir, "/")+"/")
		if err == nil && info.Type == "dir" {
			return nil
		}
		if err == nil {
			return fmt.Errorf("smh path %q exists but is not a directory", dir)
		}
	}
	return parseSMHError(resp)
}

func (s *smh) beginEnsureDir(dir string) (*smhDirEnsureFlight, bool) {
	s.dirMu.Lock()
	defer s.dirMu.Unlock()
	if _, ok := s.dirCache[dir]; ok {
		return nil, false
	}
	if flight, ok := s.dirInflight[dir]; ok {
		return flight, false
	}
	if s.dirInflight == nil {
		s.dirInflight = make(map[string]*smhDirEnsureFlight)
	}
	flight := &smhDirEnsureFlight{done: make(chan struct{})}
	s.dirInflight[dir] = flight
	return flight, true
}

func (s *smh) finishEnsureDir(dir string, flight *smhDirEnsureFlight, err error) {
	s.dirMu.Lock()
	defer s.dirMu.Unlock()
	if err == nil {
		s.markDirExistsLocked(dir)
	}
	flight.err = err
	delete(s.dirInflight, dir)
	close(flight.done)
}

func (s *smh) markDirExists(dir string) {
	dir = cleanSMHDir(dir)
	if dir == "" {
		return
	}
	s.dirMu.Lock()
	defer s.dirMu.Unlock()
	s.markDirExistsLocked(dir)
}

func (s *smh) markDirExistsLocked(dir string) {
	dir = cleanSMHDir(dir)
	if dir == "" {
		return
	}
	if s.dirCache == nil {
		s.dirCache = make(map[string]struct{})
	}
	s.dirCache[dir] = struct{}{}
}

func (s *smh) markParentDirExists(key string) {
	parent := path.Dir("/" + normalizeSMHKey(key))
	s.markDirExists(parent)
}

func (s *smh) invalidateDirCache(dir string) {
	dir = cleanSMHDir(dir)
	s.dirMu.Lock()
	defer s.dirMu.Unlock()
	delete(s.dirCache, dir)
	prefix := dir + "/"
	for cached := range s.dirCache {
		if strings.HasPrefix(cached, prefix) {
			delete(s.dirCache, cached)
		}
	}
}

func (s *smh) lookup(ctx context.Context, key string) (smhFileInfo, error) {
	resp, err := s.apiRequest(ctx, http.MethodGet, s.directoryAPIPath(normalizeInfoKey(key))+"?info", nil, nil)
	if err != nil {
		return smhFileInfo{}, err
	}
	defer cleanup(resp)
	if resp.StatusCode == http.StatusNotFound {
		return smhFileInfo{}, os.ErrNotExist
	}
	if resp.StatusCode != http.StatusOK {
		return smhFileInfo{}, parseSMHError(resp)
	}
	var info smhFileInfo
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return smhFileInfo{}, err
	}
	key = normalizeInfoKey(key)
	if info.Type == "dir" {
		s.markDirExists(key)
	} else {
		s.markParentDirExists(key)
	}
	return info, nil
}

func (s *smh) listOneLevel(ctx context.Context, prefix, startAfter string, limit int64) ([]Object, bool, string, error) {
	dirPath := "/"
	if prefix != "" {
		root := "/" + prefix
		if !strings.HasSuffix(root, "/") {
			root = path.Dir(root)
		}
		dirPath = root
	}
	dirPath = strings.Trim(strings.TrimSpace(dirPath), "/")
	objs, _, err := s.fetchAllListPages(ctx, dirPath)
	if err != nil {
		return nil, false, "", err
	}
	filtered := make([]Object, 0, len(objs))
	for _, o := range objs {
		if !strings.HasPrefix(o.Key(), prefix) {
			continue
		}
		if startAfter != "" && o.Key() <= startAfter {
			continue
		}
		filtered = append(filtered, o)
	}
	sort.Slice(filtered, func(i, j int) bool { return filtered[i].Key() < filtered[j].Key() })
	if len(filtered) > int(limit) {
		return generateListResult(filtered[:limit], limit)
	}
	return filtered, false, "", nil
}

func (s *smh) listRecursive(ctx context.Context, prefix, startAfter string, limit int64) ([]Object, bool, string, error) {
	root := strings.Trim(strings.TrimSpace(prefix), "/")
	startDir := root
	if root != "" && !strings.HasSuffix(prefix, "/") {
		startDir = strings.Trim(path.Dir("/"+root), "/")
	}
	collected := make([]Object, 0, 64)
	if err := s.walk(ctx, startDir, &collected); err != nil {
		return nil, false, "", err
	}
	filtered := make([]Object, 0, len(collected))
	for _, o := range collected {
		if prefix != "" && !strings.HasPrefix(o.Key(), prefix) {
			continue
		}
		if startAfter != "" && o.Key() <= startAfter {
			continue
		}
		filtered = append(filtered, o)
	}
	sort.Slice(filtered, func(i, j int) bool { return filtered[i].Key() < filtered[j].Key() })
	if len(filtered) > int(limit) {
		return generateListResult(filtered[:limit], limit)
	}
	return filtered, false, "", nil
}

func (s *smh) walk(ctx context.Context, dir string, collected *[]Object) error {
	objs, _, err := s.fetchAllListPages(ctx, dir)
	if err != nil {
		return err
	}
	for _, o := range objs {
		*collected = append(*collected, o)
		if o.IsDir() {
			if err := s.walk(ctx, strings.TrimSuffix(o.Key(), "/"), collected); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *smh) fetchAllListPages(ctx context.Context, dirPath string) ([]Object, string, error) {
	marker := ""
	all := make([]Object, 0, 64)
	for {
		q := url.Values{}
		q.Set("limit", "1000")
		q.Set("sort_type", "union")
		q.Set("order_by", "name")
		if marker != "" {
			q.Set("marker", marker)
		}
		resp, err := s.apiRequest(ctx, http.MethodGet, s.directoryAPIPath(dirPath)+"?"+q.Encode(), nil, nil)
		if err != nil {
			return nil, "", err
		}
		if resp.StatusCode == http.StatusNotFound {
			cleanup(resp)
			return nil, "", nil
		}
		if resp.StatusCode != http.StatusOK {
			defer cleanup(resp)
			return nil, "", parseSMHError(resp)
		}
		s.markDirExists(dirPath)
		var out smhListResponse
		if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
			cleanup(resp)
			return nil, "", err
		}
		cleanup(resp)
		for _, entry := range out.Contents {
			key := pathFromParts(entry.Path, entry.Name, entry.Type)
			if entry.Type == "dir" {
				s.markDirExists(key)
			} else {
				s.markParentDirExists(key)
			}
			obj, err := toSMHObject(key, entry)
			if err != nil {
				return nil, "", err
			}
			all = append(all, obj)
		}
		if out.NextMarker == nil || fmt.Sprint(out.NextMarker) == "" {
			return all, "", nil
		}
		marker = fmt.Sprint(out.NextMarker)
	}
}

func (s *smh) beginSimpleUpload(ctx context.Context, key string, fileSize int64) (smhBeginSimpleUploadResponse, error) {
	q := url.Values{}
	q.Set("conflict_resolution_strategy", "overwrite")
	if fileSize >= 0 {
		q.Set("filesize", strconv.FormatInt(fileSize, 10))
	}
	body := map[string]string{}
	if fileSize >= 0 {
		body["size"] = strconv.FormatInt(fileSize, 10)
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return smhBeginSimpleUploadResponse{}, err
	}
	resp, err := s.apiRequest(ctx, http.MethodPut, s.fileAPIPath(key)+"?"+q.Encode(), bytes.NewReader(payload), map[string]string{"Content-Type": "application/json"})
	if err != nil {
		return smhBeginSimpleUploadResponse{}, err
	}
	defer cleanup(resp)
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return smhBeginSimpleUploadResponse{}, parseSMHError(resp)
	}
	var out smhBeginSimpleUploadResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return smhBeginSimpleUploadResponse{}, err
	}
	return out, nil
}

func (s *smh) beginMultipartUpload(ctx context.Context, key string) (smhUploadSession, error) {
	resp, err := s.apiRequest(ctx, http.MethodPost, s.fileAPIPath(key)+"?multipart&conflict_resolution_strategy=overwrite", bytes.NewReader([]byte("{}")), map[string]string{"Content-Type": "application/json"})
	if err != nil {
		return smhUploadSession{}, err
	}
	defer cleanup(resp)
	if resp.StatusCode != http.StatusCreated {
		return smhUploadSession{}, parseSMHError(resp)
	}
	var out smhBeginMultipartUploadResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return smhUploadSession{}, err
	}
	return smhUploadSession{
		Kind:       "multipart",
		Key:        normalizeSMHKey(key),
		Domain:     out.Domain,
		Path:       out.Path,
		UploadID:   out.UploadID,
		Headers:    out.Headers,
		ConfirmKey: out.ConfirmKey,
		Expiration: out.Expiration,
	}, nil
}

func (s *smh) uploadToCOS(ctx context.Context, domain, uploadPath, uploadID string, headers map[string]string, payload io.Reader, size int64, partNumbers ...int) error {
	u := url.URL{
		Scheme: s.uploadSchemeForDomain(domain),
		Host:   domain,
		Path:   uploadPath,
	}
	q := u.Query()
	if uploadID != "" {
		q.Set("uploadId", uploadID)
	}
	if len(partNumbers) > 0 {
		q.Set("partNumber", strconv.Itoa(partNumbers[0]))
	}
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, u.String(), payload)
	if err != nil {
		return err
	}
	if size >= 0 {
		req.ContentLength = size
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	started := time.Now()
	resp, err := httpClient.Do(req)
	s.logHTTPTrace(http.MethodPut, &u, resp, err, started)
	if err != nil {
		return err
	}
	defer cleanup(resp)
	if resp.StatusCode != http.StatusOK {
		return parseSMHError(resp)
	}
	return nil
}

func (s *smh) uploadFormToCOS(ctx context.Context, domain, uploadPath string, form map[string]string, payload io.Reader) error {
	body, err := os.CreateTemp("", "juicefs-smh-form-*")
	if err != nil {
		return err
	}
	defer os.Remove(body.Name())
	defer body.Close()

	writer := multipart.NewWriter(body)
	for key, value := range form {
		if err := writer.WriteField(key, value); err != nil {
			return err
		}
	}
	part, err := writer.CreateFormFile("file", "payload")
	if err != nil {
		return err
	}
	if _, err := io.Copy(part, payload); err != nil {
		return err
	}
	if err := writer.Close(); err != nil {
		return err
	}
	size, err := body.Seek(0, io.SeekEnd)
	if err != nil {
		return err
	}
	if _, err := body.Seek(0, io.SeekStart); err != nil {
		return err
	}

	u := url.URL{
		Scheme: s.uploadSchemeForDomain(domain),
		Host:   domain,
		Path:   uploadPath,
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), body)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.ContentLength = size
	started := time.Now()
	resp, err := httpClient.Do(req)
	s.logHTTPTrace(http.MethodPost, &u, resp, err, started)
	if err != nil {
		return err
	}
	defer cleanup(resp)
	switch resp.StatusCode {
	case http.StatusOK, http.StatusCreated, http.StatusNoContent:
		return nil
	default:
		return parseSMHError(resp)
	}
}

func (s *smh) confirmUpload(ctx context.Context, confirmKey string) error {
	resp, err := s.apiRequest(ctx, http.MethodPost, fmt.Sprintf("/api/v1/file/%s/%s/%s?confirm", url.PathEscape(s.libraryID), url.PathEscape(s.spaceID), url.PathEscape(confirmKey)), bytes.NewReader([]byte("{}")), map[string]string{"Content-Type": "application/json"})
	if err != nil {
		return err
	}
	defer cleanup(resp)
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return parseSMHError(resp)
	}
	return nil
}

func (s *smh) apiRequest(ctx context.Context, method, apiPath string, body io.Reader, headers map[string]string) (*http.Response, error) {
	u, err := s.endpoint.Parse(apiPath)
	if err != nil {
		return nil, err
	}
	q := u.Query()
	q.Set("access_token", s.accessToken)
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, method, u.String(), body)
	if err != nil {
		return nil, err
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	started := time.Now()
	resp, err := httpClient.Do(req)
	s.logHTTPTrace(method, u, resp, err, started)
	return resp, err
}

func (s *smh) logHTTPTrace(method string, u *url.URL, resp *http.Response, err error, started time.Time) {
	if !smhHTTPTraceEnabled() {
		return
	}
	status := 0
	if resp != nil {
		status = resp.StatusCode
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "smh_http method=%s url=%s status=%d duration=%s err=%v\n", method, smhTraceURL(u), status, time.Since(started).Round(time.Millisecond), err)
		return
	}
	fmt.Fprintf(os.Stderr, "smh_http method=%s url=%s status=%d duration=%s\n", method, smhTraceURL(u), status, time.Since(started).Round(time.Millisecond))
}

func smhHTTPTraceEnabled() bool {
	v := strings.TrimSpace(os.Getenv("SMH_HTTP_TRACE"))
	return v != "" && v != "0" && !strings.EqualFold(v, "false")
}

func smhTraceURL(u *url.URL) string {
	if u == nil {
		return ""
	}
	clean := *u
	q := clean.Query()
	if q.Has("access_token") {
		q.Set("access_token", "<redacted>")
	}
	clean.RawQuery = q.Encode()
	return clean.Redacted()
}

func remainingReaderSize(rs io.ReadSeeker) (int64, error) {
	cur, err := rs.Seek(0, io.SeekCurrent)
	if err != nil {
		return 0, err
	}
	end, err := rs.Seek(0, io.SeekEnd)
	if err != nil {
		return 0, err
	}
	if _, err := rs.Seek(cur, io.SeekStart); err != nil {
		return 0, err
	}
	return end - cur, nil
}

func (s *smh) directoryAPIPath(dir string) string {
	dir = strings.Trim(strings.TrimSpace(dir), "/")
	if dir == "" {
		return fmt.Sprintf("/api/v1/directory/%s/%s/", url.PathEscape(s.libraryID), url.PathEscape(s.spaceID))
	}
	return fmt.Sprintf("/api/v1/directory/%s/%s/%s", url.PathEscape(s.libraryID), url.PathEscape(s.spaceID), escapeSMHPath(dir))
}

func (s *smh) fileAPIPath(key string) string {
	key = normalizeSMHKey(key)
	return fmt.Sprintf("/api/v1/file/%s/%s/%s", url.PathEscape(s.libraryID), url.PathEscape(s.spaceID), escapeSMHPath(key))
}

func (s *smh) uploadSchemeForDomain(domain string) string {
	if strings.HasPrefix(domain, "127.0.0.1:") || strings.HasPrefix(domain, "localhost:") || domain == "127.0.0.1" || domain == "localhost" {
		return "http"
	}
	return s.endpoint.Scheme
}

func normalizeSMHKey(key string) string {
	key = strings.TrimSpace(key)
	key = strings.TrimPrefix(key, "/")
	return key
}

func cleanSMHDir(dir string) string {
	dir = strings.Trim(strings.TrimSpace(dir), "/")
	if dir == "." {
		return ""
	}
	return dir
}

func normalizeInfoKey(key string) string {
	key = normalizeSMHKey(key)
	return strings.TrimSuffix(key, "/")
}

func escapeSMHPath(key string) string {
	if key == "" {
		return ""
	}
	parts := strings.Split(strings.Trim(key, "/"), "/")
	for i, part := range parts {
		parts[i] = url.PathEscape(part)
	}
	return strings.Join(parts, "/")
}

func pathFromParts(parts []string, fallbackName, typ string) string {
	if len(parts) == 0 {
		if fallbackName == "" {
			return ""
		}
		if typ == "dir" {
			return fallbackName + "/"
		}
		return fallbackName
	}
	key := strings.Join(parts, "/")
	if typ == "dir" && !strings.HasSuffix(key, "/") {
		key += "/"
	}
	return key
}

func toSMHObject(key string, info smhFileInfo) (Object, error) {
	mtime, _ := time.Parse(time.RFC3339, info.ModificationTime)
	size, _ := strconv.ParseInt(info.Size, 10, 64)
	key = normalizeSMHKey(key)
	if info.Type == "dir" && key != "" && !strings.HasSuffix(key, "/") {
		key += "/"
	}
	return &obj{
		key:    key,
		size:   size,
		mtime:  mtime,
		isDir:  info.Type == "dir",
		status: "",
	}, nil
}

func encodeSMHUploadSession(session smhUploadSession) (string, error) {
	data, err := json.Marshal(session)
	if err != nil {
		return "", err
	}
	return "smh:" + base64.RawURLEncoding.EncodeToString(data), nil
}

func decodeSMHUploadSession(uploadID string) (smhUploadSession, error) {
	if !strings.HasPrefix(uploadID, "smh:") {
		return smhUploadSession{}, fmt.Errorf("invalid smh upload id")
	}
	data, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(uploadID, "smh:"))
	if err != nil {
		return smhUploadSession{}, err
	}
	var out smhUploadSession
	if err := json.Unmarshal(data, &out); err != nil {
		return smhUploadSession{}, err
	}
	return out, nil
}

func parseSMHError(resp *http.Response) error {
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("smh http %d", resp.StatusCode)
	}
	if resp.StatusCode == http.StatusNotFound {
		return os.ErrNotExist
	}
	return fmt.Errorf("smh http %d: %s", resp.StatusCode, strings.TrimSpace(string(data)))
}

func firstNonEmptySMH(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func newSMH(endpoint, accessKey, secretKey, token string) (ObjectStorage, error) {
	if !strings.Contains(endpoint, "://") {
		endpoint = "https://" + endpoint
	}
	uri, err := url.Parse(endpoint)
	if err != nil {
		return nil, fmt.Errorf("invalid smh endpoint %q: %w", endpoint, err)
	}
	q := uri.Query()
	libraryID := strings.TrimSpace(q.Get("library_id"))
	spaceID := strings.TrimSpace(q.Get("space_id"))
	accessToken := firstNonEmptySMH(accessKey, token, secretKey, q.Get("access_token"), os.Getenv("SMH_ACCESS_TOKEN"), os.Getenv("ACCESS_KEY"))
	if libraryID == "" || spaceID == "" || accessToken == "" {
		return nil, fmt.Errorf("smh requires endpoint query library_id, space_id, and access token as accessKey or access_token query")
	}
	permanent := true
	if v := strings.TrimSpace(q.Get("permanent")); v == "0" || strings.EqualFold(v, "false") {
		permanent = false
	}
	uri.RawQuery = ""
	return &smh{
		endpoint:    uri,
		libraryID:   libraryID,
		spaceID:     spaceID,
		accessToken: accessToken,
		permanent:   permanent,
	}, nil
}

func init() {
	Register("smh", newSMH)
}
