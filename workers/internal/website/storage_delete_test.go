package website

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/tencentyun/cos-go-sdk-v5"
)

func TestCleanupRejectsPartialCOSDeletion(t *testing.T) {
	for _, cleanup := range []string{"prefix", "legacy-retention"} {
		t.Run(cleanup, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/xml")
				if r.Method == "GET" {
					w.Write([]byte(`<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>sites/ws-1/releases/wr-old/index.html</Key><Size>10</Size></Contents></ListBucketResult>`))
					return
				}
				if r.Method == "POST" {
					w.Write([]byte(`<DeleteResult><Error><Key>sites/ws-1/releases/wr-old/index.html</Key><Code>AccessDenied</Code><Message>denied</Message></Error></DeleteResult>`))
					return
				}
				t.Errorf("unexpected method %s", r.Method)
			}))
			defer server.Close()
			endpoint, _ := url.Parse(server.URL)
			client := &cosClient{client: cos.NewClient(&cos.BaseURL{BucketURL: endpoint}, server.Client())}
			d := &Deployer{}
			var err error
			if cleanup == "prefix" {
				err = d.deleteCosPrefix(client, "sites/ws-1/releases/wr-old/", Operation{})
			} else {
				err = d.pruneSiteReleases(client, "ws-1", "wr-new", "sites/ws-1/releases/wr-active/")
			}
			if err == nil {
				t.Fatal("HTTP 200 with per-object deletion failure reported success")
			}
		})
	}
}
