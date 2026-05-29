package object

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestSMHObjectStorageLive(t *testing.T) {
	libraryID := strings.TrimSpace(os.Getenv("SMH_LIBRARY_ID"))
	accessDomain := strings.TrimSpace(os.Getenv("SMH_ACCESS_DOMAIN"))
	librarySecret := strings.TrimSpace(os.Getenv("SMH_LIBRARY_SECRET"))
	if libraryID == "" || accessDomain == "" || librarySecret == "" {
		t.Skip("set SMH_LIBRARY_ID, SMH_ACCESS_DOMAIN, and SMH_LIBRARY_SECRET to run live SMH integration")
	}

	client := &http.Client{Timeout: 30 * time.Second}
	issueToken := func(spaceID string, grant string) string {
		t.Helper()
		q := url.Values{}
		q.Set("library_id", libraryID)
		q.Set("library_secret", librarySecret)
		if spaceID != "" {
			q.Set("space_id", spaceID)
		}
		q.Set("grant", grant)
		q.Set("period", "3600")
		resp, err := client.Get(strings.TrimRight(accessDomain, "/") + "/api/v1/token?" + q.Encode())
		if err != nil {
			t.Fatal(err)
		}
		defer cleanup(resp)
		if resp.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(resp.Body)
			t.Fatalf("issue token http %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
		}
		var out struct {
			AccessToken string `json:"accessToken"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
			t.Fatal(err)
		}
		if out.AccessToken == "" {
			t.Fatal("empty access token")
		}
		return out.AccessToken
	}

	createToken := issueToken("", "create_space,admin")
	spaceTag := fmt.Sprintf("codex-live-%d", time.Now().UnixNano())
	payload, _ := json.Marshal(map[string]string{"spaceTag": spaceTag})
	req, err := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/api/v1/space/%s?access_token=%s", strings.TrimRight(accessDomain, "/"), url.PathEscape(libraryID), url.QueryEscape(createToken)), strings.NewReader(string(payload)))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup(resp)
	if resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("create space http %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var space struct {
		SpaceID string `json:"spaceId"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&space); err != nil {
		t.Fatal(err)
	}
	if space.SpaceID == "" {
		t.Fatal("empty space id")
	}

	spaceToken := issueToken(space.SpaceID, "admin")
	endpoint := fmt.Sprintf("%s?library_id=%s&space_id=%s", accessDomain, libraryID, space.SpaceID)
	store, err := CreateStorage("smh", endpoint, spaceToken, "", "")
	if err != nil {
		t.Fatal(err)
	}
	backend, ok := store.(*smh)
	if !ok {
		t.Fatalf("unexpected backend type %T", store)
	}

	key := "probe.txt"
	want := "hello smh range test\n"

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	upload, err := backend.beginSimpleUpload(ctx, key, int64(len(want)))
	if err != nil {
		t.Fatalf("begin simple upload: %v", err)
	}
	if len(upload.Form) > 0 {
		if err := backend.uploadFormToCOS(ctx, upload.Domain, upload.Path, upload.Form, strings.NewReader(want)); err != nil {
			t.Fatalf("form upload: %v", err)
		}
	} else {
		if err := backend.uploadToCOS(ctx, upload.Domain, upload.Path, "", upload.Headers, strings.NewReader(want), int64(len(want))); err != nil {
			t.Fatalf("put upload: %v", err)
		}
	}
	confirmResp, err := backend.apiRequest(ctx, http.MethodPost, fmt.Sprintf("/api/v1/file/%s/%s/%s?confirm", url.PathEscape(backend.libraryID), url.PathEscape(backend.spaceID), url.PathEscape(upload.ConfirmKey)), bytes.NewReader([]byte("{}")), map[string]string{"Content-Type": "application/json"})
	if err != nil {
		t.Fatalf("confirm request: %v", err)
	}
	confirmBody, _ := io.ReadAll(confirmResp.Body)
	_ = confirmResp.Body.Close()
	if confirmResp.StatusCode != http.StatusOK && confirmResp.StatusCode != http.StatusCreated {
		t.Fatalf("confirm status=%d body=%s", confirmResp.StatusCode, string(confirmBody))
	}

	ctx, cancel = context.WithTimeout(context.Background(), 30*time.Second)
	head, err := store.Head(ctx, key)
	cancel()
	if err != nil {
		t.Fatalf("head: %v confirm_body=%s", err, string(confirmBody))
	}
	if head.Size() != int64(len(want)) {
		t.Fatalf("head size=%d want=%d", head.Size(), len(want))
	}

	ctx, cancel = context.WithTimeout(context.Background(), 30*time.Second)
	rc, err := store.Get(ctx, key, 0, 5)
	if err != nil {
		cancel()
		t.Fatalf("get range: %v", err)
	}
	rangeBody, err := io.ReadAll(rc)
	_ = rc.Close()
	cancel()
	if err != nil {
		t.Fatalf("read range: %v", err)
	}
	if got := string(rangeBody); got != "hello" {
		t.Fatalf("range body=%q", got)
	}

	ctx, cancel = context.WithTimeout(context.Background(), 30*time.Second)
	full, err := store.Get(ctx, key, 0, -1)
	if err != nil {
		cancel()
		t.Fatalf("get full: %v", err)
	}
	fullBody, err := io.ReadAll(full)
	_ = full.Close()
	cancel()
	if err != nil {
		t.Fatalf("read full: %v", err)
	}
	if got := string(fullBody); got != want {
		t.Fatalf("full body=%q want=%q", got, want)
	}

	overwrite := "HELLO overwrite test\n"
	ctx, cancel = context.WithTimeout(context.Background(), 30*time.Second)
	upload2, err := backend.beginSimpleUpload(ctx, key, int64(len(overwrite)))
	if err != nil {
		cancel()
		t.Fatalf("begin overwrite upload: %v", err)
	}
	if len(upload2.Form) > 0 {
		if err := backend.uploadFormToCOS(ctx, upload2.Domain, upload2.Path, upload2.Form, strings.NewReader(overwrite)); err != nil {
			cancel()
			t.Fatalf("overwrite form upload: %v", err)
		}
	} else {
		if err := backend.uploadToCOS(ctx, upload2.Domain, upload2.Path, "", upload2.Headers, strings.NewReader(overwrite), int64(len(overwrite))); err != nil {
			cancel()
			t.Fatalf("overwrite put upload: %v", err)
		}
	}
	if err := backend.confirmUpload(ctx, upload2.ConfirmKey); err != nil {
		cancel()
		t.Fatalf("overwrite confirm: %v", err)
	}
	cancel()

	ctx, cancel = context.WithTimeout(context.Background(), 30*time.Second)
	full, err = store.Get(ctx, key, 0, -1)
	if err != nil {
		cancel()
		t.Fatalf("get overwritten full: %v", err)
	}
	overwrittenBody, err := io.ReadAll(full)
	_ = full.Close()
	cancel()
	if err != nil {
		t.Fatalf("read overwritten full: %v", err)
	}
	if got := string(overwrittenBody); got != overwrite {
		t.Fatalf("overwrite mismatch body=%q want=%q", got, overwrite)
	}

	streamKey := "stream/non-seekable.txt"
	streamBody := "hello live streaming put\n"
	ctx, cancel = context.WithTimeout(context.Background(), 30*time.Second)
	if err := store.Put(ctx, streamKey, struct{ io.Reader }{strings.NewReader(streamBody)}); err != nil {
		cancel()
		t.Fatalf("put non-seekable stream: %v", err)
	}
	cancel()
	ctx, cancel = context.WithTimeout(context.Background(), 30*time.Second)
	streamRC, err := store.Get(ctx, streamKey, 0, -1)
	if err != nil {
		cancel()
		t.Fatalf("get non-seekable stream: %v", err)
	}
	liveStreamBody, err := io.ReadAll(streamRC)
	_ = streamRC.Close()
	cancel()
	if err != nil {
		t.Fatalf("read non-seekable stream: %v", err)
	}
	if got := string(liveStreamBody); got != streamBody {
		t.Fatalf("stream body=%q want=%q", got, streamBody)
	}

	nestedKey := "dir/sub.txt"
	ctx, cancel = context.WithTimeout(context.Background(), 30*time.Second)
	if err := store.Put(ctx, nestedKey, strings.NewReader("nested")); err != nil {
		cancel()
		t.Fatalf("put nested: %v", err)
	}
	cancel()

	chunkKey := "chunks/0/0/123_0_4096"
	chunkBody := strings.Repeat("c", 4096)
	ctx, cancel = context.WithTimeout(context.Background(), 30*time.Second)
	if err := store.Put(ctx, chunkKey, strings.NewReader(chunkBody)); err != nil {
		cancel()
		t.Fatalf("put chunk-like key: %v", err)
	}
	cancel()
	ctx, cancel = context.WithTimeout(context.Background(), 30*time.Second)
	chunkHead, err := store.Head(ctx, chunkKey)
	cancel()
	if err != nil {
		t.Fatalf("head chunk-like key: %v", err)
	}
	if chunkHead.Size() != int64(len(chunkBody)) {
		t.Fatalf("chunk head size=%d want=%d", chunkHead.Size(), len(chunkBody))
	}
	ctx, cancel = context.WithTimeout(context.Background(), 30*time.Second)
	chunkRC, err := store.Get(ctx, chunkKey, 0, 16)
	if err != nil {
		cancel()
		t.Fatalf("get chunk-like range: %v", err)
	}
	chunkPrefix, err := io.ReadAll(chunkRC)
	_ = chunkRC.Close()
	cancel()
	if err != nil {
		t.Fatalf("read chunk-like range: %v", err)
	}
	if got := string(chunkPrefix); got != strings.Repeat("c", 16) {
		t.Fatalf("chunk-like range=%q", got)
	}

	ctx, cancel = context.WithTimeout(context.Background(), 30*time.Second)
	errCh := make(chan error, 4)
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		i := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			key := fmt.Sprintf("concurrent/%d.txt", i)
			body := fmt.Sprintf("body-%d", i)
			if err := store.Put(ctx, key, strings.NewReader(body)); err != nil {
				errCh <- fmt.Errorf("put %s: %w", key, err)
				return
			}
			rc, err := store.Get(ctx, key, 0, -1)
			if err != nil {
				errCh <- fmt.Errorf("get %s: %w", key, err)
				return
			}
			defer rc.Close()
			got, err := io.ReadAll(rc)
			if err != nil {
				errCh <- fmt.Errorf("read %s: %w", key, err)
				return
			}
			if string(got) != body {
				errCh <- fmt.Errorf("body mismatch for %s: %q", key, string(got))
			}
		}()
	}
	wg.Wait()
	close(errCh)
	cancel()
	for err := range errCh {
		if err != nil {
			t.Fatal(err)
		}
	}

	sequentialKey := "concurrent/2.txt"
	ctx, cancel = context.WithTimeout(context.Background(), 30*time.Second)
	if err := store.Put(ctx, sequentialKey, strings.NewReader("sequential-retry")); err != nil {
		cancel()
		t.Fatalf("sequential retry put %s: %v", sequentialKey, err)
	}
	cancel()

	ctx, cancel = context.WithTimeout(context.Background(), 30*time.Second)
	objs, _, _, err := store.List(ctx, "", "", "", "/", 100, false)
	cancel()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	found := false
	foundDir := false
	for _, o := range objs {
		if o.Key() == key {
			found = true
		}
		if o.Key() == "dir/" {
			foundDir = true
		}
	}
	if !found || !foundDir {
		raw := ""
		if backend, ok := store.(*smh); ok {
			resp, err := backend.apiRequest(context.Background(), http.MethodGet, backend.directoryAPIPath("")+"?limit=1000&sort_type=union&order_by=name", nil, nil)
			if err == nil {
				defer cleanup(resp)
				body, _ := io.ReadAll(resp.Body)
				raw = string(body)
			}
		}
		t.Fatalf("list missing key=%v dir=%v objs=%+v raw=%s", found, foundDir, objs, raw)
	}
}

func TestSMHMultipartLiveStatusAndRenew(t *testing.T) {
	libraryID := strings.TrimSpace(os.Getenv("SMH_LIBRARY_ID"))
	accessDomain := strings.TrimSpace(os.Getenv("SMH_ACCESS_DOMAIN"))
	librarySecret := strings.TrimSpace(os.Getenv("SMH_LIBRARY_SECRET"))
	if libraryID == "" || accessDomain == "" || librarySecret == "" {
		t.Skip("set SMH_LIBRARY_ID, SMH_ACCESS_DOMAIN, and SMH_LIBRARY_SECRET to run live SMH integration")
	}

	client := &http.Client{Timeout: 30 * time.Second}
	issueToken := func(spaceID string, grant string) string {
		t.Helper()
		q := url.Values{}
		q.Set("library_id", libraryID)
		q.Set("library_secret", librarySecret)
		if spaceID != "" {
			q.Set("space_id", spaceID)
		}
		q.Set("grant", grant)
		q.Set("period", "3600")
		resp, err := client.Get(strings.TrimRight(accessDomain, "/") + "/api/v1/token?" + q.Encode())
		if err != nil {
			t.Fatal(err)
		}
		defer cleanup(resp)
		if resp.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(resp.Body)
			t.Fatalf("issue token http %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
		}
		var out struct {
			AccessToken string `json:"accessToken"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
			t.Fatal(err)
		}
		if out.AccessToken == "" {
			t.Fatal("empty access token")
		}
		return out.AccessToken
	}

	createToken := issueToken("", "create_space,admin")
	spaceTag := fmt.Sprintf("codex-multipart-%d", time.Now().UnixNano())
	payload, _ := json.Marshal(map[string]string{"spaceTag": spaceTag})
	req, err := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/api/v1/space/%s?access_token=%s", strings.TrimRight(accessDomain, "/"), url.PathEscape(libraryID), url.QueryEscape(createToken)), strings.NewReader(string(payload)))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup(resp)
	if resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("create space http %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var space struct {
		SpaceID string `json:"spaceId"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&space); err != nil {
		t.Fatal(err)
	}
	spaceToken := issueToken(space.SpaceID, "admin")
	endpoint := fmt.Sprintf("%s?library_id=%s&space_id=%s", accessDomain, libraryID, space.SpaceID)
	raw, err := CreateStorage("smh", endpoint, spaceToken, "", "")
	if err != nil {
		t.Fatal(err)
	}
	store := raw.(*smh)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	key := "multipart/live.bin"
	upload, err := store.CreateMultipartUpload(ctx, key)
	if err != nil {
		t.Fatalf("create multipart: %v", err)
	}
	partBody := []byte("multipart-live-body")
	part, err := store.UploadPart(ctx, key, upload.UploadID, 1, partBody)
	if err != nil {
		t.Fatalf("upload part: %v", err)
	}
	if part == nil || part.Num != 1 {
		t.Fatalf("unexpected part: %+v", part)
	}
	status, err := store.UploadStatus(ctx, upload.UploadID)
	if err != nil {
		t.Fatalf("upload status: %v", err)
	}
	if status.Confirmed {
		t.Fatalf("upload unexpectedly confirmed: %+v", status)
	}
	if status.UploadID == "" || len(status.Parts) == 0 || status.Parts[0].PartNumber != 1 {
		t.Fatalf("unexpected upload status: %+v", status)
	}
	renewedUploadID, err := store.RenewUpload(ctx, upload.UploadID)
	if err != nil {
		t.Fatalf("renew upload: %v", err)
	}
	if !strings.HasPrefix(renewedUploadID, "smh:") {
		t.Fatalf("renewed upload id=%q", renewedUploadID)
	}
	if err := store.CompleteUpload(ctx, key, renewedUploadID, []*Part{part}); err != nil {
		t.Fatalf("complete upload: %v", err)
	}
	rc, err := store.Get(ctx, key, 0, -1)
	if err != nil {
		t.Fatalf("get completed multipart: %v", err)
	}
	defer rc.Close()
	body, err := io.ReadAll(rc)
	if err != nil {
		t.Fatalf("read completed multipart: %v", err)
	}
	if got := string(body); got != string(partBody) {
		t.Fatalf("completed multipart body=%q want=%q", got, string(partBody))
	}
}

func TestSMHMultipartLiveAbort(t *testing.T) {
	libraryID := strings.TrimSpace(os.Getenv("SMH_LIBRARY_ID"))
	accessDomain := strings.TrimSpace(os.Getenv("SMH_ACCESS_DOMAIN"))
	librarySecret := strings.TrimSpace(os.Getenv("SMH_LIBRARY_SECRET"))
	if libraryID == "" || accessDomain == "" || librarySecret == "" {
		t.Skip("set SMH_LIBRARY_ID, SMH_ACCESS_DOMAIN, and SMH_LIBRARY_SECRET to run live SMH integration")
	}

	client := &http.Client{Timeout: 30 * time.Second}
	issueToken := func(spaceID string, grant string) string {
		t.Helper()
		q := url.Values{}
		q.Set("library_id", libraryID)
		q.Set("library_secret", librarySecret)
		if spaceID != "" {
			q.Set("space_id", spaceID)
		}
		q.Set("grant", grant)
		q.Set("period", "3600")
		resp, err := client.Get(strings.TrimRight(accessDomain, "/") + "/api/v1/token?" + q.Encode())
		if err != nil {
			t.Fatal(err)
		}
		defer cleanup(resp)
		if resp.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(resp.Body)
			t.Fatalf("issue token http %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
		}
		var out struct {
			AccessToken string `json:"accessToken"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
			t.Fatal(err)
		}
		return out.AccessToken
	}

	createToken := issueToken("", "create_space,admin")
	spaceTag := fmt.Sprintf("codex-abort-%d", time.Now().UnixNano())
	payload, _ := json.Marshal(map[string]string{"spaceTag": spaceTag})
	req, err := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/api/v1/space/%s?access_token=%s", strings.TrimRight(accessDomain, "/"), url.PathEscape(libraryID), url.QueryEscape(createToken)), strings.NewReader(string(payload)))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup(resp)
	if resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("create space http %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var space struct {
		SpaceID string `json:"spaceId"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&space); err != nil {
		t.Fatal(err)
	}

	spaceToken := issueToken(space.SpaceID, "admin")
	endpoint := fmt.Sprintf("%s?library_id=%s&space_id=%s", accessDomain, libraryID, space.SpaceID)
	raw, err := CreateStorage("smh", endpoint, spaceToken, "", "")
	if err != nil {
		t.Fatal(err)
	}
	store := raw.(*smh)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	upload, err := store.CreateMultipartUpload(ctx, "abort/live.bin")
	if err != nil {
		t.Fatalf("create multipart: %v", err)
	}
	if _, err := store.UploadPart(ctx, "abort/live.bin", upload.UploadID, 1, []byte("abc")); err != nil {
		t.Fatalf("upload part: %v", err)
	}
	store.AbortUpload(ctx, "abort/live.bin", upload.UploadID)
	if _, err := store.UploadStatus(ctx, upload.UploadID); err == nil {
		t.Fatal("expected upload status to fail after abort")
	}
}

func TestSMHListLiveSemantics(t *testing.T) {
	libraryID := strings.TrimSpace(os.Getenv("SMH_LIBRARY_ID"))
	accessDomain := strings.TrimSpace(os.Getenv("SMH_ACCESS_DOMAIN"))
	librarySecret := strings.TrimSpace(os.Getenv("SMH_LIBRARY_SECRET"))
	if libraryID == "" || accessDomain == "" || librarySecret == "" {
		t.Skip("set SMH_LIBRARY_ID, SMH_ACCESS_DOMAIN, and SMH_LIBRARY_SECRET to run live SMH integration")
	}

	client := &http.Client{Timeout: 30 * time.Second}
	issueToken := func(spaceID string, grant string) string {
		t.Helper()
		q := url.Values{}
		q.Set("library_id", libraryID)
		q.Set("library_secret", librarySecret)
		if spaceID != "" {
			q.Set("space_id", spaceID)
		}
		q.Set("grant", grant)
		q.Set("period", "3600")
		resp, err := client.Get(strings.TrimRight(accessDomain, "/") + "/api/v1/token?" + q.Encode())
		if err != nil {
			t.Fatal(err)
		}
		defer cleanup(resp)
		if resp.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(resp.Body)
			t.Fatalf("issue token http %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
		}
		var out struct {
			AccessToken string `json:"accessToken"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
			t.Fatal(err)
		}
		return out.AccessToken
	}

	createToken := issueToken("", "create_space,admin")
	spaceTag := fmt.Sprintf("codex-list-%d", time.Now().UnixNano())
	payload, _ := json.Marshal(map[string]string{"spaceTag": spaceTag})
	req, err := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/api/v1/space/%s?access_token=%s", strings.TrimRight(accessDomain, "/"), url.PathEscape(libraryID), url.QueryEscape(createToken)), strings.NewReader(string(payload)))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup(resp)
	if resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("create space http %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var space struct {
		SpaceID string `json:"spaceId"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&space); err != nil {
		t.Fatal(err)
	}

	spaceToken := issueToken(space.SpaceID, "admin")
	endpoint := fmt.Sprintf("%s?library_id=%s&space_id=%s", accessDomain, libraryID, space.SpaceID)
	raw, err := CreateStorage("smh", endpoint, spaceToken, "", "")
	if err != nil {
		t.Fatal(err)
	}
	store := raw.(*smh)
	ctx := context.Background()
	put := func(key string) {
		t.Helper()
		cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		if err := store.Put(cctx, key, strings.NewReader("x")); err != nil {
			t.Fatalf("put %s: %v", key, err)
		}
	}
	for _, key := range []string{
		"a/a", "a/a1", "a/b/c/d/e/f", "a1", "b/a", "b/b", "c", "test",
	} {
		put(key)
	}

	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	obs, more, nextMarker, err := store.List(cctx, "", "", "", "/", 4, true)
	cancel()
	if err != nil {
		t.Fatalf("root paged list: %v", err)
	}
	if len(obs) != 4 || !more || nextMarker == "" {
		t.Fatalf("root paged list len=%d more=%v marker=%q objs=%+v", len(obs), more, nextMarker, obs)
	}
	wantRootPage1 := []string{"a/", "a1", "b/", "c"}
	for i, o := range obs {
		if o.Key() != wantRootPage1[i] {
			t.Fatalf("root page1[%d]=%q want=%q", i, o.Key(), wantRootPage1[i])
		}
	}

	cctx, cancel = context.WithTimeout(ctx, 30*time.Second)
	obs2, more2, nextMarker2, err := store.List(cctx, "", obs[len(obs)-1].Key(), nextMarker, "/", 4, true)
	cancel()
	if err != nil {
		t.Fatalf("root page2 list: %v", err)
	}
	if len(obs2) != 1 || obs2[0].Key() != "test" || more2 || nextMarker2 != "" {
		t.Fatalf("root page2 len=%d key=%v more=%v marker=%q objs=%+v", len(obs2), func() string {
			if len(obs2) > 0 {
				return obs2[0].Key()
			}
			return ""
		}(), more2, nextMarker2, obs2)
	}

	cctx, cancel = context.WithTimeout(ctx, 30*time.Second)
	prefixA, _, _, err := store.List(cctx, "a", "", "", "/", 10, true)
	cancel()
	if err != nil {
		t.Fatalf("prefix a list: %v", err)
	}
	wantPrefixA := []string{"a/", "a1"}
	if len(prefixA) != len(wantPrefixA) {
		t.Fatalf("prefix a len=%d objs=%+v", len(prefixA), prefixA)
	}
	for i, o := range prefixA {
		if o.Key() != wantPrefixA[i] {
			t.Fatalf("prefix a[%d]=%q want=%q", i, o.Key(), wantPrefixA[i])
		}
	}

	cctx, cancel = context.WithTimeout(ctx, 30*time.Second)
	prefixADir, _, _, err := store.List(cctx, "a/", "", "", "/", 10, true)
	cancel()
	if err != nil {
		t.Fatalf("prefix a/ list: %v", err)
	}
	wantPrefixADir := []string{"a/a", "a/a1", "a/b/"}
	if len(prefixADir) != len(wantPrefixADir) {
		t.Fatalf("prefix a/ len=%d objs=%+v", len(prefixADir), prefixADir)
	}
	for i, o := range prefixADir {
		if o.Key() != wantPrefixADir[i] {
			t.Fatalf("prefix a/[%d]=%q want=%q", i, o.Key(), wantPrefixADir[i])
		}
	}
}
