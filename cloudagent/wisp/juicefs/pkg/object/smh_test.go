package object

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeSMHServer struct {
	mu                sync.Mutex
	files             map[string][]byte
	dirs              map[string]bool
	uploads           map[string]*fakeUpload
	dirPutCount       map[string]int
	dirInfoCount      map[string]int
	formPut           bool
	lastBeginHadSize  bool
	lastUploadChunked bool
	lastContentLength int64
}

type fakeUpload struct {
	key        string
	confirmKey string
	parts      map[int][]byte
}

func newFakeSMHServer() *fakeSMHServer {
	return &fakeSMHServer{
		files:        make(map[string][]byte),
		dirs:         map[string]bool{"": true},
		uploads:      make(map[string]*fakeUpload),
		dirPutCount:  make(map[string]int),
		dirInfoCount: make(map[string]int),
	}
}

func TestSMHObjectStorageUsesEnvToken(t *testing.T) {
	fake := newFakeSMHServer()
	server := httptest.NewServer(http.HandlerFunc(fake.handler))
	defer server.Close()
	t.Setenv("SMH_ACCESS_TOKEN", "env-token")

	store, err := CreateStorage("smh", server.URL+"?library_id=lib&space_id=space", "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Put(context.Background(), "env-token.txt", strings.NewReader("ok")); err != nil {
		t.Fatal(err)
	}
}

func TestSMHTraceURLRedactsAccessToken(t *testing.T) {
	u, err := url.Parse("https://example.api.tencentsmh.cn/api/v1/file/lib/space/foo?access_token=secret&confirm")
	if err != nil {
		t.Fatal(err)
	}
	got := smhTraceURL(u)
	if strings.Contains(got, "secret") {
		t.Fatalf("trace URL leaked token: %s", got)
	}
	if !strings.Contains(got, "access_token=%3Credacted%3E") {
		t.Fatalf("trace URL did not redact token: %s", got)
	}
}

func TestSMHAPIRequestDoesNotDuplicateQueryParams(t *testing.T) {
	fake := newFakeSMHServer()
	server := httptest.NewServer(http.HandlerFunc(fake.handler))
	defer server.Close()

	store, err := CreateStorage("smh", server.URL+"?library_id=lib&space_id=space", "tok", "", "")
	if err != nil {
		t.Fatal(err)
	}
	s, ok := store.(*smh)
	if !ok {
		t.Fatalf("unexpected store type %T", store)
	}
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, server.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := s.apiRequest(req.Context(), http.MethodGet, "/api/v1/directory/lib/space/path?limit=1000&sort_type=union", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup(resp)
	if got := resp.Request.URL.Query()["limit"]; len(got) != 1 || got[0] != "1000" {
		t.Fatalf("limit query duplicated or missing: %v", got)
	}
	if got := resp.Request.URL.Query()["sort_type"]; len(got) != 1 || got[0] != "union" {
		t.Fatalf("sort_type query duplicated or missing: %v", got)
	}
	if got := resp.Request.URL.Query()["access_token"]; len(got) != 1 || got[0] != "tok" {
		t.Fatalf("access_token query missing: %v", got)
	}
}

func (s *fakeSMHServer) ensureDir(dir string) {
	dir = strings.Trim(dir, "/")
	if dir == "" {
		s.dirs[""] = true
		return
	}
	parts := strings.Split(dir, "/")
	cur := ""
	for _, part := range parts {
		if cur == "" {
			cur = part
		} else {
			cur = cur + "/" + part
		}
		s.dirs[cur] = true
	}
}

func (s *fakeSMHServer) handler(w http.ResponseWriter, r *http.Request) {
	switch {
	case strings.HasPrefix(r.URL.Path, "/api/v1/token"):
		_ = json.NewEncoder(w).Encode(map[string]any{"accessToken": "tok", "expiresIn": 600})
		return
	case strings.HasPrefix(r.URL.Path, "/api/v1/file/"):
		s.handleFileAPI(w, r)
		return
	case strings.HasPrefix(r.URL.Path, "/api/v1/directory/"):
		s.handleDirectoryAPI(w, r)
		return
	case strings.HasPrefix(r.URL.Path, "/upload/"):
		s.handleUpload(w, r)
		return
	case strings.HasPrefix(r.URL.Path, "/upload-form/"):
		s.handleFormUpload(w, r)
		return
	default:
		http.NotFound(w, r)
	}
}

func (s *fakeSMHServer) handleFileAPI(w http.ResponseWriter, r *http.Request) {
	trimmed := strings.TrimPrefix(r.URL.Path, "/api/v1/file/lib/space/")
	isContent := strings.HasSuffix(trimmed, "/content")
	if isContent {
		trimmed = strings.TrimSuffix(trimmed, "/content")
	}
	pathParts := strings.Split(trimmed, "/")
	key, _ := url.PathUnescape(strings.Join(pathParts, "/"))
	q := r.URL.Query()
	if q.Has("upload") && r.Method == http.MethodGet {
		s.mu.Lock()
		defer s.mu.Unlock()
		var upload *fakeUpload
		for _, u := range s.uploads {
			if u.confirmKey == key {
				upload = u
				break
			}
		}
		if upload == nil {
			http.Error(w, `{"code":"UploadNotFound"}`, http.StatusNotFound)
			return
		}
		partNums := make([]int, 0, len(upload.parts))
		for num := range upload.parts {
			partNums = append(partNums, num)
		}
		sort.Ints(partNums)
		parts := make([]map[string]any, 0, len(partNums))
		for _, num := range partNums {
			parts = append(parts, map[string]any{
				"PartNumber":   num,
				"LastModified": time.Now().UTC().Format(time.RFC3339),
				"ETag":         fmt.Sprintf("\"etag-%d\"", num),
				"Size":         len(upload.parts[num]),
			})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"confirmed": false,
			"path":      []string{upload.key},
			"uploadId":  "upload-" + strings.ReplaceAll(upload.key, "/", "_"),
			"parts":     parts,
			"uploadPartInfo": map[string]any{
				"domain":     strings.TrimPrefix(r.Host, "http://"),
				"path":       "/upload/" + upload.key,
				"uploadId":   "upload-" + strings.ReplaceAll(upload.key, "/", "_"),
				"headers":    map[string]string{"Content-Type": "application/octet-stream"},
				"expiration": time.Now().Add(10 * time.Minute).UTC().Format(time.RFC3339),
			},
		})
		return
	}
	if q.Has("upload") && r.Method == http.MethodDelete {
		s.mu.Lock()
		defer s.mu.Unlock()
		for uploadKey, u := range s.uploads {
			if u.confirmKey == key {
				delete(s.uploads, uploadKey)
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		http.Error(w, `{"code":"UploadNotFound"}`, http.StatusNotFound)
		return
	}
	if q.Has("renew") && r.Method == http.MethodPost {
		s.mu.Lock()
		defer s.mu.Unlock()
		var upload *fakeUpload
		for _, u := range s.uploads {
			if u.confirmKey == key {
				upload = u
				break
			}
		}
		if upload == nil {
			http.Error(w, `{"code":"UploadNotFound"}`, http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"domain":     strings.TrimPrefix(r.Host, "http://"),
			"path":       "/upload/" + upload.key,
			"uploadId":   "upload-" + strings.ReplaceAll(upload.key, "/", "_"),
			"headers":    map[string]string{"Content-Type": "application/octet-stream"},
			"confirmKey": upload.confirmKey,
			"expiration": time.Now().Add(10 * time.Minute).UTC().Format(time.RFC3339),
		})
		return
	}
	if q.Has("confirm") && r.Method == http.MethodPost {
		s.mu.Lock()
		defer s.mu.Unlock()
		var upload *fakeUpload
		for _, u := range s.uploads {
			if u.confirmKey == key {
				upload = u
				break
			}
		}
		if upload == nil {
			http.Error(w, `{"code":"UploadNotFound"}`, http.StatusNotFound)
			return
		}
		partNums := make([]int, 0, len(upload.parts))
		for num := range upload.parts {
			partNums = append(partNums, num)
		}
		sort.Ints(partNums)
		var all []byte
		for _, num := range partNums {
			all = append(all, upload.parts[num]...)
		}
		s.files[upload.key] = all
		s.ensureDir(path.Dir(upload.key))
		delete(s.uploads, upload.key)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"path":             []string{upload.key},
			"name":             path.Base(upload.key),
			"type":             "file",
			"creationTime":     time.Now().UTC().Format(time.RFC3339),
			"modificationTime": time.Now().UTC().Format(time.RFC3339),
			"contentType":      "application/octet-stream",
			"size":             strconv.Itoa(len(all)),
			"eTag":             "\"etag\"",
			"crc64":            "1",
			"metaData":         map[string]string{},
			"isOverwritten":    false,
		})
		return
	}
	if q.Has("multipart") && r.Method == http.MethodPost {
		uploadID := "upload-" + strings.ReplaceAll(key, "/", "_")
		confirmKey := "confirm-" + strings.ReplaceAll(key, "/", "_")
		s.mu.Lock()
		s.uploads[key] = &fakeUpload{key: key, confirmKey: confirmKey, parts: map[int][]byte{}}
		s.mu.Unlock()
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"domain":     strings.TrimPrefix(r.Host, "http://"),
			"path":       "/upload/" + key,
			"uploadId":   uploadID,
			"headers":    map[string]string{"Content-Type": "application/octet-stream"},
			"confirmKey": confirmKey,
			"expiration": time.Now().Add(10 * time.Minute).UTC().Format(time.RFC3339),
		})
		return
	}
	if r.Method == http.MethodPut {
		if q.Get("uploadId") != "" {
			http.Error(w, "use upload endpoint", http.StatusBadRequest)
			return
		}
		if strings.Contains(r.Header.Get("Content-Type"), "application/json") {
			var body struct {
				CopyFrom string `json:"copyFrom"`
				Size     string `json:"size"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			if body.CopyFrom == "" {
				s.mu.Lock()
				s.lastBeginHadSize = body.Size != "" || q.Get("filesize") != ""
				s.mu.Unlock()
				if s.formPut {
					confirmKey := "confirm-" + strings.ReplaceAll(key, "/", "_")
					s.mu.Lock()
					s.uploads[key] = &fakeUpload{key: key, confirmKey: confirmKey, parts: map[int][]byte{}}
					s.mu.Unlock()
					_ = json.NewEncoder(w).Encode(map[string]any{
						"domain":     strings.TrimPrefix(r.Host, "http://"),
						"path":       "/upload-form/",
						"form":       map[string]string{"key": key},
						"confirmKey": confirmKey,
						"expiration": time.Now().Add(10 * time.Minute).UTC().Format(time.RFC3339),
					})
					return
				}
				_ = json.NewEncoder(w).Encode(map[string]any{
					"domain":     strings.TrimPrefix(r.Host, "http://"),
					"path":       "/upload/" + key,
					"headers":    map[string]string{"Content-Type": "application/octet-stream"},
					"confirmKey": "confirm-" + strings.ReplaceAll(key, "/", "_"),
					"expiration": time.Now().Add(10 * time.Minute).UTC().Format(time.RFC3339),
				})
				return
			}
			s.mu.Lock()
			data, ok := s.files[body.CopyFrom]
			if ok {
				s.files[key] = append([]byte(nil), data...)
				s.ensureDir(path.Dir(key))
			}
			s.mu.Unlock()
			if !ok {
				http.Error(w, `{"code":"FileNotFound"}`, http.StatusNotFound)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"path": []string{key}})
			return
		}
		payload, _ := io.ReadAll(r.Body)
		s.mu.Lock()
		s.files[key] = payload
		s.ensureDir(path.Dir(key))
		s.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{
			"domain":     strings.TrimPrefix(r.Host, "http://"),
			"path":       "/upload/" + key,
			"headers":    map[string]string{"Content-Type": "application/octet-stream"},
			"confirmKey": "confirm-" + strings.ReplaceAll(key, "/", "_"),
			"expiration": time.Now().Add(10 * time.Minute).UTC().Format(time.RFC3339),
		})
		return
	}
	if r.Method == http.MethodDelete {
		s.mu.Lock()
		delete(s.files, key)
		s.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method == http.MethodGet {
		s.mu.Lock()
		data, ok := s.files[key]
		s.mu.Unlock()
		if !ok {
			http.Error(w, `{"code":"FileNotFound"}`, http.StatusNotFound)
			return
		}
		rangeHeader := r.Header.Get("Range")
		if rangeHeader != "" {
			var start, end int
			if _, err := fmt.Sscanf(rangeHeader, "bytes=%d-%d", &start, &end); err == nil {
				if end >= len(data) {
					end = len(data) - 1
				}
				if start < 0 || start >= len(data) || end < start {
					w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
					return
				}
				w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, len(data)))
				w.WriteHeader(http.StatusPartialContent)
				_, _ = w.Write(data[start : end+1])
				return
			}
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
		return
	}
	http.NotFound(w, r)
}

func (s *fakeSMHServer) handleDirectoryAPI(w http.ResponseWriter, r *http.Request) {
	dirPath := strings.TrimPrefix(r.URL.Path, "/api/v1/directory/lib/space/")
	dirPath, _ = url.PathUnescape(dirPath)
	dirPath = strings.Trim(dirPath, "/")
	if r.URL.Query().Has("info") {
		s.mu.Lock()
		s.dirInfoCount[dirPath]++
		s.mu.Unlock()
		if dirPath == "" {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"path":             []string{},
				"name":             "",
				"type":             "dir",
				"creationTime":     time.Now().UTC().Format(time.RFC3339),
				"modificationTime": time.Now().UTC().Format(time.RFC3339),
				"size":             "0",
			})
			return
		}
		s.mu.Lock()
		_, isFile := s.files[dirPath]
		hasDir := s.dirs[dirPath]
		prefix := dirPath + "/"
		for key := range s.files {
			if strings.HasPrefix(key, prefix) {
				hasDir = true
				break
			}
		}
		s.mu.Unlock()
		if !isFile && !hasDir {
			http.Error(w, `{"code":"FileNotFound"}`, http.StatusNotFound)
			return
		}
		typ := "dir"
		size := "0"
		if isFile {
			typ = "file"
			s.mu.Lock()
			size = strconv.Itoa(len(s.files[dirPath]))
			s.mu.Unlock()
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"path":             strings.Split(dirPath, "/"),
			"name":             path.Base(dirPath),
			"type":             typ,
			"creationTime":     time.Now().UTC().Format(time.RFC3339),
			"modificationTime": time.Now().UTC().Format(time.RFC3339),
			"size":             size,
			"eTag":             "\"etag\"",
			"crc64":            "1",
			"contentType":      "application/octet-stream",
			"metaData":         map[string]string{},
		})
		return
	}
	if r.Method == http.MethodPut {
		s.mu.Lock()
		s.dirPutCount[dirPath]++
		s.ensureDir(dirPath)
		s.mu.Unlock()
		w.WriteHeader(http.StatusCreated)
		return
	}
	if r.Method == http.MethodDelete {
		s.mu.Lock()
		prefix := dirPath + "/"
		for key := range s.files {
			if strings.HasPrefix(key, prefix) {
				delete(s.files, key)
			}
		}
		for key := range s.dirs {
			if key == dirPath || strings.HasPrefix(key, prefix) {
				delete(s.dirs, key)
			}
		}
		s.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method == http.MethodGet {
		s.mu.Lock()
		defer s.mu.Unlock()
		prefix := ""
		if dirPath != "" {
			prefix = dirPath + "/"
		}
		children := make(map[string]smhFileInfo)
		for dir := range s.dirs {
			if dir == "" || dir == dirPath || !strings.HasPrefix(dir, prefix) {
				continue
			}
			rest := strings.TrimPrefix(dir, prefix)
			if rest == "" {
				continue
			}
			parts := strings.Split(rest, "/")
			name := parts[0]
			fullParts := append([]string{}, strings.Split(strings.Trim(dirPath, "/"), "/")...)
			if dirPath == "" {
				fullParts = nil
			}
			fullParts = append(fullParts, name)
			entryKey := strings.Join(fullParts, "/")
			children[entryKey] = smhFileInfo{
				Path:             fullParts,
				Name:             name,
				Type:             "dir",
				CreationTime:     time.Now().UTC().Format(time.RFC3339),
				ModificationTime: time.Now().UTC().Format(time.RFC3339),
				Size:             "0",
			}
		}
		for key, data := range s.files {
			if !strings.HasPrefix(key, prefix) {
				continue
			}
			rest := strings.TrimPrefix(key, prefix)
			if rest == "" {
				continue
			}
			parts := strings.Split(rest, "/")
			name := parts[0]
			fullParts := append([]string{}, strings.Split(strings.Trim(dirPath, "/"), "/")...)
			if dirPath == "" {
				fullParts = nil
			}
			fullParts = append(fullParts, name)
			entryKey := strings.Join(fullParts, "/")
			if len(parts) > 1 {
				children[entryKey] = smhFileInfo{
					Path:             fullParts,
					Name:             name,
					Type:             "dir",
					CreationTime:     time.Now().UTC().Format(time.RFC3339),
					ModificationTime: time.Now().UTC().Format(time.RFC3339),
					Size:             "0",
				}
				continue
			}
			children[entryKey] = smhFileInfo{
				Path:             fullParts,
				Name:             name,
				Type:             "file",
				CreationTime:     time.Now().UTC().Format(time.RFC3339),
				ModificationTime: time.Now().UTC().Format(time.RFC3339),
				Size:             strconv.Itoa(len(data)),
				ETag:             "\"etag\"",
				CRC64:            "1",
				ContentType:      "application/octet-stream",
				MetaData:         map[string]string{},
			}
		}
		keys := make([]string, 0, len(children))
		for key := range children {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		contents := make([]smhFileInfo, 0, len(keys))
		for _, key := range keys {
			contents = append(contents, children[key])
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"path":        strings.Split(strings.Trim(dirPath, "/"), "/"),
			"nextMarker":  nil,
			"fileCount":   len(contents),
			"subDirCount": 0,
			"totalNum":    len(contents),
			"contents":    contents,
		})
		return
	}
	http.NotFound(w, r)
}

func (s *fakeSMHServer) handleUpload(w http.ResponseWriter, r *http.Request) {
	key := strings.TrimPrefix(r.URL.Path, "/upload/")
	key, _ = url.PathUnescape(key)
	uploadID := r.URL.Query().Get("uploadId")
	partNumber := r.URL.Query().Get("partNumber")
	body, _ := io.ReadAll(r.Body)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastUploadChunked = r.ContentLength == -1
	s.lastContentLength = r.ContentLength
	u, ok := s.uploads[key]
	if !ok {
		u = &fakeUpload{key: key, confirmKey: "confirm-" + strings.ReplaceAll(key, "/", "_"), parts: map[int][]byte{}}
		s.uploads[key] = u
	}
	if uploadID == "" {
		u.parts[1] = body
		w.WriteHeader(http.StatusOK)
		return
	}
	num, _ := strconv.Atoi(partNumber)
	u.parts[num] = body
	w.WriteHeader(http.StatusOK)
}

func (s *fakeSMHServer) handleFormUpload(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(8 << 20); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	key := r.FormValue("key")
	file, _, err := r.FormFile("file")
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	defer file.Close()
	payload, _ := io.ReadAll(file)
	s.mu.Lock()
	u, ok := s.uploads[key]
	if !ok {
		u = &fakeUpload{key: key, confirmKey: "confirm-" + strings.ReplaceAll(key, "/", "_"), parts: map[int][]byte{}}
		s.uploads[key] = u
	}
	u.parts[1] = payload
	s.mu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

func TestSMHObjectStoragePoC(t *testing.T) {
	fake := newFakeSMHServer()
	srv := httptest.NewServer(http.HandlerFunc(fake.handler))
	defer srv.Close()

	store, err := newSMH(srv.URL+"?library_id=lib&space_id=space", "tok", "", "")
	if err != nil {
		t.Fatal(err)
	}
	testStorage(t, store)
}

func TestSMHObjectStoragePoCFormUpload(t *testing.T) {
	fake := newFakeSMHServer()
	fake.formPut = true
	srv := httptest.NewServer(http.HandlerFunc(fake.handler))
	defer srv.Close()

	store, err := newSMH(srv.URL+"?library_id=lib&space_id=space", "tok", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Put(context.Background(), "form.txt", strings.NewReader("hello form")); err != nil {
		t.Fatal(err)
	}
	rc, err := store.Get(context.Background(), "form.txt", 0, -1)
	if err != nil {
		t.Fatal(err)
	}
	defer rc.Close()
	body, err := io.ReadAll(rc)
	if err != nil {
		t.Fatal(err)
	}
	if got := string(body); got != "hello form" {
		t.Fatalf("body=%q", got)
	}
}

func TestSMHObjectStorageStreamsNonSeekablePutWithoutSize(t *testing.T) {
	fake := newFakeSMHServer()
	srv := httptest.NewServer(http.HandlerFunc(fake.handler))
	defer srv.Close()

	store, err := newSMH(srv.URL+"?library_id=lib&space_id=space", "tok", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Put(context.Background(), "stream.txt", struct{ io.Reader }{strings.NewReader("hello stream")}); err != nil {
		t.Fatal(err)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.lastBeginHadSize {
		t.Fatal("non-seekable Put should omit SMH filesize")
	}
	if !fake.lastUploadChunked {
		t.Fatalf("non-seekable Put should stream without ContentLength, got %d", fake.lastContentLength)
	}
}

func TestSMHMultipartStatusAndRenew(t *testing.T) {
	fake := newFakeSMHServer()
	srv := httptest.NewServer(http.HandlerFunc(fake.handler))
	defer srv.Close()

	raw, err := newSMH(srv.URL+"?library_id=lib&space_id=space", "tok", "", "")
	if err != nil {
		t.Fatal(err)
	}
	store := raw.(*smh)
	ctx := context.Background()
	upload, err := store.CreateMultipartUpload(ctx, "large.bin")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.UploadPart(ctx, "large.bin", upload.UploadID, 1, []byte("abc")); err != nil {
		t.Fatal(err)
	}
	status, err := store.UploadStatus(ctx, upload.UploadID)
	if err != nil {
		t.Fatal(err)
	}
	if status.UploadID == "" || len(status.Parts) != 1 || status.Parts[0].PartNumber != 1 {
		t.Fatalf("unexpected status: %+v", status)
	}
	renewed, err := store.RenewUpload(ctx, upload.UploadID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(renewed, "smh:") {
		t.Fatalf("renewed upload id=%q", renewed)
	}
}

func TestSMHMultipartAbort(t *testing.T) {
	fake := newFakeSMHServer()
	srv := httptest.NewServer(http.HandlerFunc(fake.handler))
	defer srv.Close()

	raw, err := newSMH(srv.URL+"?library_id=lib&space_id=space", "tok", "", "")
	if err != nil {
		t.Fatal(err)
	}
	store := raw.(*smh)
	ctx := context.Background()
	upload, err := store.CreateMultipartUpload(ctx, "abort.bin")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.UploadPart(ctx, "abort.bin", upload.UploadID, 1, []byte("abc")); err != nil {
		t.Fatal(err)
	}
	store.AbortUpload(ctx, "abort.bin", upload.UploadID)
	if _, err := store.UploadStatus(ctx, upload.UploadID); err == nil {
		t.Fatal("expected upload status to fail after abort")
	}
}

func TestSMHEnsureDirTreatsExistingDirectoryConflictAsSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPut && strings.Contains(r.URL.Path, "/api/v1/directory/lib/space/parent"):
			http.Error(w, `{"code":"SameNameDirectoryOrFileExists"}`, http.StatusConflict)
		case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/api/v1/directory/lib/space/parent"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"path":             []string{"parent"},
				"name":             "parent",
				"type":             "dir",
				"creationTime":     time.Now().UTC().Format(time.RFC3339),
				"modificationTime": time.Now().UTC().Format(time.RFC3339),
				"size":             "0",
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	raw, err := newSMH(srv.URL+"?library_id=lib&space_id=space", "tok", "", "")
	if err != nil {
		t.Fatal(err)
	}
	store := raw.(*smh)
	if err := store.ensureDir(context.Background(), "parent"); err != nil {
		t.Fatal(err)
	}
}

func TestSMHPutCachesKnownParentDirectory(t *testing.T) {
	fake := newFakeSMHServer()
	srv := httptest.NewServer(http.HandlerFunc(fake.handler))
	defer srv.Close()

	raw, err := newSMH(srv.URL+"?library_id=lib&space_id=space", "tok", "", "")
	if err != nil {
		t.Fatal(err)
	}
	store := raw.(*smh)
	ctx := context.Background()
	for _, name := range []string{
		"data/default/chunks/0/0/1_0_3072",
		"data/default/chunks/0/0/2_0_1024",
		"data/default/chunks/0/0/3_0_4096",
	} {
		if err := store.Put(ctx, name, strings.NewReader("chunk")); err != nil {
			t.Fatal(err)
		}
	}

	fake.mu.Lock()
	defer fake.mu.Unlock()
	if got := fake.dirPutCount["data/default/chunks/0/0"]; got != 1 {
		t.Fatalf("directory PUT count=%d want 1", got)
	}
	if got := fake.dirInfoCount["data/default/chunks/0/0"]; got != 0 {
		t.Fatalf("directory info count=%d want 0", got)
	}
}

func TestSMHLookupCachesExistingDirectory(t *testing.T) {
	fake := newFakeSMHServer()
	fake.mu.Lock()
	fake.ensureDir("workspace-fast/default")
	fake.mu.Unlock()
	srv := httptest.NewServer(http.HandlerFunc(fake.handler))
	defer srv.Close()

	raw, err := newSMH(srv.URL+"?library_id=lib&space_id=space", "tok", "", "")
	if err != nil {
		t.Fatal(err)
	}
	store := raw.(*smh)
	ctx := context.Background()
	if _, err := store.lookup(ctx, "workspace-fast/default/"); err != nil {
		t.Fatal(err)
	}
	if err := store.Put(ctx, "workspace-fast/default/meta.db--ltx--0000", strings.NewReader("ltx")); err != nil {
		t.Fatal(err)
	}

	fake.mu.Lock()
	defer fake.mu.Unlock()
	if got := fake.dirInfoCount["workspace-fast/default"]; got != 1 {
		t.Fatalf("directory info count=%d want 1", got)
	}
	if got := fake.dirPutCount["workspace-fast/default"]; got != 0 {
		t.Fatalf("directory PUT count=%d want 0 after lookup cached directory", got)
	}
}

func TestSMHListCachesListedDirectories(t *testing.T) {
	fake := newFakeSMHServer()
	fake.mu.Lock()
	fake.ensureDir("workspace-fast/default/data/default")
	fake.mu.Unlock()
	srv := httptest.NewServer(http.HandlerFunc(fake.handler))
	defer srv.Close()

	raw, err := newSMH(srv.URL+"?library_id=lib&space_id=space", "tok", "", "")
	if err != nil {
		t.Fatal(err)
	}
	store := raw.(*smh)
	ctx := context.Background()
	if _, _, _, err := store.List(ctx, "workspace-fast/default/", "", "", "", 1000, false); err != nil {
		t.Fatal(err)
	}
	if err := store.Put(ctx, "workspace-fast/default/data/default/new-file", strings.NewReader("data")); err != nil {
		t.Fatal(err)
	}

	fake.mu.Lock()
	defer fake.mu.Unlock()
	if got := fake.dirPutCount["workspace-fast/default"]; got != 0 {
		t.Fatalf("listed root directory PUT count=%d want 0", got)
	}
	if got := fake.dirPutCount["workspace-fast/default/data/default"]; got != 0 {
		t.Fatalf("listed child directory PUT count=%d want 0", got)
	}
	if got := fake.dirInfoCount["workspace-fast/default/data/default"]; got != 0 {
		t.Fatalf("listed child directory info count=%d want 0", got)
	}
}

func TestSMHPutSingleflightsConcurrentParentDirectoryCreation(t *testing.T) {
	fake := newFakeSMHServer()
	release := make(chan struct{})
	dirPutStarted := make(chan struct{})
	var dirPutStartedOnce sync.Once
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPut && strings.Contains(r.URL.Path, "/api/v1/directory/lib/space/data/default/chunks/0/0") {
			dirPutStartedOnce.Do(func() { close(dirPutStarted) })
			<-release
		}
		fake.handler(w, r)
	}))
	defer srv.Close()

	raw, err := newSMH(srv.URL+"?library_id=lib&space_id=space", "tok", "", "")
	if err != nil {
		t.Fatal(err)
	}
	store := raw.(*smh)

	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for _, name := range []string{
		"data/default/chunks/0/0/1_0_3072",
		"data/default/chunks/0/0/2_0_1024",
	} {
		wg.Add(1)
		go func(name string) {
			defer wg.Done()
			errs <- store.Put(context.Background(), name, strings.NewReader("chunk"))
		}(name)
	}
	<-dirPutStarted
	close(release)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}

	fake.mu.Lock()
	defer fake.mu.Unlock()
	if got := fake.dirPutCount["data/default/chunks/0/0"]; got != 1 {
		t.Fatalf("directory PUT count=%d want 1", got)
	}
}

func TestSMHDeleteDirectoryInvalidatesDirectoryCache(t *testing.T) {
	fake := newFakeSMHServer()
	srv := httptest.NewServer(http.HandlerFunc(fake.handler))
	defer srv.Close()

	raw, err := newSMH(srv.URL+"?library_id=lib&space_id=space", "tok", "", "")
	if err != nil {
		t.Fatal(err)
	}
	store := raw.(*smh)
	ctx := context.Background()
	if err := store.Put(ctx, "data/default/chunks/0/0/1_0_3072", strings.NewReader("chunk")); err != nil {
		t.Fatal(err)
	}
	if err := store.Delete(ctx, "data/default/chunks/0/0/"); err != nil {
		t.Fatal(err)
	}
	if err := store.Put(ctx, "data/default/chunks/0/0/2_0_1024", strings.NewReader("chunk")); err != nil {
		t.Fatal(err)
	}

	fake.mu.Lock()
	defer fake.mu.Unlock()
	if got := fake.dirPutCount["data/default/chunks/0/0"]; got != 2 {
		t.Fatalf("directory PUT count=%d want 2 after delete invalidation", got)
	}
}
