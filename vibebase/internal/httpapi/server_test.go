package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"git.woa.com/wisp/mono/vibebase/internal/store"
)

type fakeStore struct {
	entries map[string]store.Entry
}

func (f *fakeStore) Put(_ context.Context, ownerID string, namespace string, key string, value []byte) (store.Entry, bool, error) {
	if f.entries == nil {
		f.entries = map[string]store.Entry{}
	}
	id := ownerID + "/" + namespace + "/" + key
	_, exists := f.entries[id]
	entry := store.Entry{Namespace: namespace, Key: key, Value: string(value), Size: len(value), UpdatedAt: time.Unix(0, 0).UTC()}
	f.entries[id] = entry
	return entry, !exists, nil
}

func (f *fakeStore) Get(_ context.Context, ownerID string, namespace string, key string) (store.Entry, error) {
	entry, ok := f.entries[ownerID+"/"+namespace+"/"+key]
	if !ok {
		return store.Entry{}, store.ErrNotFound
	}
	return entry, nil
}

func (f *fakeStore) Delete(_ context.Context, ownerID string, namespace string, key string) (bool, error) {
	id := ownerID + "/" + namespace + "/" + key
	if _, ok := f.entries[id]; !ok {
		return false, nil
	}
	delete(f.entries, id)
	return true, nil
}

func (f *fakeStore) List(_ context.Context, ownerID string, namespace string, _ string, _ int) (store.ListPage, error) {
	var entries []store.Entry
	for id, entry := range f.entries {
		if bytes.HasPrefix([]byte(id), []byte(ownerID+"/"+namespace+"/")) {
			entry.Value = ""
			entries = append(entries, entry)
		}
	}
	return store.ListPage{Entries: entries}, nil
}

func (f *fakeStore) Ping(context.Context) error { return nil }

func TestRejectsMissingTrustedIdentity(t *testing.T) {
	handler := New(Options{Store: &fakeStore{}, InternalServiceToken: "secret", MaxNameBytes: 5000, MaxValueBytes: 5000})
	req := httptest.NewRequest(http.MethodPut, "/v1/namespaces/prefs/kv/theme", bytes.NewBufferString("dark"))
	req.Header.Set("Authorization", "Bearer secret")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected unauthorized, got %d", rec.Code)
	}
}

func TestStoresUnderInjectedUserOnly(t *testing.T) {
	backend := &fakeStore{}
	handler := New(Options{Store: backend, InternalServiceToken: "secret", MaxNameBytes: 5000, MaxValueBytes: 5000})

	put := httptest.NewRequest(http.MethodPut, "/v1/namespaces/prefs/kv/theme", bytes.NewBufferString("dark"))
	put.Header.Set("Authorization", "Bearer secret")
	put.Header.Set(identityUserHeader, "user-a")
	put.Header.Set("X-User-Id", "attacker")
	putRec := httptest.NewRecorder()
	handler.ServeHTTP(putRec, put)
	if putRec.Code != http.StatusCreated {
		t.Fatalf("put status=%d body=%s", putRec.Code, putRec.Body.String())
	}

	get := httptest.NewRequest(http.MethodGet, "/v1/namespaces/prefs/kv/theme", nil)
	get.Header.Set("Authorization", "Bearer secret")
	get.Header.Set(identityUserHeader, "user-a")
	getRec := httptest.NewRecorder()
	handler.ServeHTTP(getRec, get)
	if getRec.Code != http.StatusOK {
		t.Fatalf("get status=%d body=%s", getRec.Code, getRec.Body.String())
	}
	var got store.Entry
	if err := json.Unmarshal(getRec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Value != "dark" {
		t.Fatalf("unexpected value %q", got.Value)
	}

	cross := httptest.NewRequest(http.MethodGet, "/v1/namespaces/prefs/kv/theme", nil)
	cross.Header.Set("Authorization", "Bearer secret")
	cross.Header.Set(identityUserHeader, "user-b")
	crossRec := httptest.NewRecorder()
	handler.ServeHTTP(crossRec, cross)
	if crossRec.Code != http.StatusNotFound {
		t.Fatalf("cross-user get status=%d body=%s", crossRec.Code, crossRec.Body.String())
	}
}

func TestRejectsOversizedKeyAndValue(t *testing.T) {
	handler := New(Options{Store: &fakeStore{}, InternalServiceToken: "secret", MaxNameBytes: 4, MaxValueBytes: 3})
	req := httptest.NewRequest(http.MethodPut, "/v1/namespaces/prefs/kv/toolong", bytes.NewBufferString("abc"))
	req.Header.Set("Authorization", "Bearer secret")
	req.Header.Set(identityUserHeader, "user-a")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected key bad request, got %d", rec.Code)
	}

	req = httptest.NewRequest(http.MethodPut, "/v1/namespaces/p/kv/k", bytes.NewBufferString("abcd"))
	req.Header.Set("Authorization", "Bearer secret")
	req.Header.Set(identityUserHeader, "user-a")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected value too large, got %d", rec.Code)
	}
}

func TestRejectsNonUTF8KeyAndValue(t *testing.T) {
	handler := New(Options{Store: &fakeStore{}, InternalServiceToken: "secret", MaxNameBytes: 5000, MaxValueBytes: 5000})

	req := httptest.NewRequest(http.MethodPut, "/v1/namespaces/prefs/kv/%ff", bytes.NewBufferString("ok"))
	req.Header.Set("Authorization", "Bearer secret")
	req.Header.Set(identityUserHeader, "user-a")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected bad request for non-UTF-8 key, got %d body=%s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodPut, "/v1/namespaces/prefs/kv/k", bytes.NewBuffer([]byte{0xff, 0xfe, 'a'}))
	req.Header.Set("Authorization", "Bearer secret")
	req.Header.Set(identityUserHeader, "user-a")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected bad request for non-UTF-8 value, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestLimitsBuddyDrawnSouls(t *testing.T) {
	handler := New(Options{Store: &fakeStore{}, InternalServiceToken: "secret", MaxNameBytes: 5000, MaxValueBytes: 5000})

	validPayload := map[string]any{
		"version":     1,
		"drawnSouls":  make([]map[string]string, 8),
		"appliedSlug": nil,
		"updatedAt":   1,
	}
	body, err := json.Marshal(validPayload)
	if err != nil {
		t.Fatalf("marshal valid payload: %v", err)
	}
	req := httptest.NewRequest(http.MethodPut, "/v1/namespaces/agent-state/kv/buddy.ins-1", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer secret")
	req.Header.Set(identityUserHeader, "user-a")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected created for 8 souls, got %d body=%s", rec.Code, rec.Body.String())
	}

	tooManyPayload := map[string]any{
		"version":     1,
		"drawnSouls":  make([]map[string]string, 9),
		"appliedSlug": nil,
		"updatedAt":   1,
	}
	body, err = json.Marshal(tooManyPayload)
	if err != nil {
		t.Fatalf("marshal oversized payload: %v", err)
	}
	req = httptest.NewRequest(http.MethodPut, "/v1/namespaces/agent-state/kv/buddy.ins-1", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer secret")
	req.Header.Set(identityUserHeader, "user-a")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected bad request for 9 souls, got %d body=%s", rec.Code, rec.Body.String())
	}
	var got map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode error response: %v", err)
	}
	if got["error"] != "buddy_drawn_souls_too_many" {
		t.Fatalf("unexpected error code %q", got["error"])
	}
}

// TestBuddySoulCapIgnoresOtherKeys 守门反向用例：
// 校验仅作用于 namespace=agent-state + key 以 "buddy." 开头的写入；
// 其他 namespace、或同 namespace 但 key 前缀不同的写入应当完全不被该校验影响。
// 用大数组 (drawnSouls=100) 故意触发上限，期望仍然 201 通过。
// 这条测试用来锁住 validateBuddyStateValue 的早返回行为，防止后续重构误伤。
func TestBuddySoulCapIgnoresOtherKeys(t *testing.T) {
	handler := New(Options{Store: &fakeStore{}, InternalServiceToken: "secret", MaxNameBytes: 5000, MaxValueBytes: 5000})

	oversizedPayload := map[string]any{
		"version":    1,
		"drawnSouls": make([]map[string]string, 100),
	}
	body, err := json.Marshal(oversizedPayload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	cases := []struct {
		name string
		path string
	}{
		// 不同 namespace：上限不应触发
		{name: "other_namespace", path: "/v1/namespaces/prefs/kv/buddy.ins-1"},
		// 同 namespace 但 key 前缀不匹配：上限不应触发
		{name: "agent_state_non_buddy_key", path: "/v1/namespaces/agent-state/kv/other.ins-1"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPut, tc.path, bytes.NewReader(body))
			req.Header.Set("Authorization", "Bearer secret")
			req.Header.Set(identityUserHeader, "user-a")
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			if rec.Code != http.StatusCreated {
				t.Fatalf("expected created (cap should not apply), got %d body=%s", rec.Code, rec.Body.String())
			}
		})
	}
}
