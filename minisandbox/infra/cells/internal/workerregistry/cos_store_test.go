package workerregistry

import (
	"context"
	"errors"
	"hash/crc64"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
)

func TestCOSObjectStoreConditionalImmutability(t *testing.T) {
	var mu sync.Mutex
	objects := map[string][]byte{}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch request.Method {
		case http.MethodHead:
			writer.WriteHeader(http.StatusOK)
		case http.MethodPut:
			if request.Header.Get("x-cos-forbid-overwrite") != "true" {
				t.Errorf("x-cos-forbid-overwrite = %q", request.Header.Get("x-cos-forbid-overwrite"))
			}
			if _, found := objects[request.URL.Path]; found {
				writer.Header().Set("Content-Type", "application/xml")
				writer.WriteHeader(http.StatusConflict)
				_, _ = writer.Write([]byte(`<Error><Code>FileAlreadyExists</Code></Error>`))
				return
			}
			body, err := io.ReadAll(request.Body)
			if err != nil {
				t.Error(err)
			}
			objects[request.URL.Path] = body
			writer.Header().Set("x-cos-hash-crc64ecma", strconv.FormatUint(crc64.Checksum(body, crc64.MakeTable(crc64.ECMA)), 10))
			writer.WriteHeader(http.StatusOK)
		case http.MethodGet:
			content, found := objects[request.URL.Path]
			if !found {
				writer.WriteHeader(http.StatusNotFound)
				return
			}
			writer.WriteHeader(http.StatusOK)
			_, _ = writer.Write(content)
		default:
			writer.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	defer server.Close()

	store, err := NewCOSObjectStore(COSConfig{BucketURL: server.URL, SecretID: "id", SecretKey: "key"})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
	created, err := store.PutImmutable(context.Background(), "versions/test.json", []byte("same"))
	if err != nil || !created {
		t.Fatalf("first put: created=%v err=%v", created, err)
	}
	created, err = store.PutImmutable(context.Background(), "versions/test.json", []byte("same"))
	if err != nil || created {
		t.Fatalf("idempotent put: created=%v err=%v", created, err)
	}
	if _, err := store.PutImmutable(context.Background(), "versions/test.json", []byte("different")); !errors.Is(err, ErrImmutableConflict) {
		t.Fatalf("conflicting put error = %v", err)
	}
}
