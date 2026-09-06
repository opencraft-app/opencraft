package rescuemultipart

import (
	"context"
	"encoding/xml"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"testing"

	cos "github.com/tencentyun/cos-go-sdk-v5"
)

func TestCOSClientUploadsPartsWithLengthAndCompletes(t *testing.T) {
	var uploaded bool
	var completed bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPut && r.URL.Query().Get("partNumber") == "1":
			if r.URL.Query().Get("uploadId") != "upload-test" {
				t.Fatalf("uploadId = %q", r.URL.Query().Get("uploadId"))
			}
			if r.ContentLength != 4 {
				t.Fatalf("Content-Length = %d", r.ContentLength)
			}
			body, _ := io.ReadAll(r.Body)
			if string(body) != "part" {
				t.Fatalf("body = %q", body)
			}
			w.Header().Set("ETag", `"etag-one"`)
			uploaded = true
		case r.Method == http.MethodPost && r.URL.Query().Get("uploadId") == "upload-test":
			var payload cos.CompleteMultipartUploadOptions
			if err := xml.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Fatal(err)
			}
			if len(payload.Parts) != 1 || payload.Parts[0].PartNumber != 1 || payload.Parts[0].ETag != `"etag-one"` {
				t.Fatalf("parts = %#v", payload.Parts)
			}
			w.Header().Set("Content-Type", "application/xml")
			_, _ = io.WriteString(w, `<CompleteMultipartUploadResult><Location>test</Location><Bucket>bucket</Bucket><Key>archive.zip</Key><ETag>done</ETag></CompleteMultipartUploadResult>`)
			completed = true
		default:
			http.Error(w, r.Method+" "+r.URL.String(), http.StatusBadRequest)
		}
	}))
	defer server.Close()

	bucketURL, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	sdk := cos.NewClient(&cos.BaseURL{BucketURL: bucketURL}, &http.Client{Transport: http.DefaultTransport})
	sdk.Conf.EnableCRC = false
	client, err := NewCOSClient(sdk, "archive.zip", "upload-test")
	if err != nil {
		t.Fatal(err)
	}
	etag, err := client.UploadPart(context.Background(), 1, []byte("part"))
	if err != nil {
		t.Fatal(err)
	}
	if etag != `"etag-one"` {
		t.Fatalf("etag = %q", etag)
	}
	if err := client.Complete(context.Background(), []CompletedPart{{Number: 1, ETag: etag}}); err != nil {
		t.Fatal(err)
	}
	if !uploaded || !completed {
		t.Fatalf("uploaded=%s completed=%s", strconv.FormatBool(uploaded), strconv.FormatBool(completed))
	}
}

func TestNewCOSClientRejectsMissingIdentity(t *testing.T) {
	if _, err := NewCOSClient(nil, "archive.zip", "upload-test"); err == nil {
		t.Fatal("expected missing SDK client error")
	}
	if _, err := NewCOSClient(&cos.Client{}, "", "upload-test"); err == nil {
		t.Fatal("expected missing object key error")
	}
	if _, err := NewCOSClient(&cos.Client{}, "archive.zip", ""); err == nil {
		t.Fatal("expected missing upload ID error")
	}
}
