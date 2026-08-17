package selfupdate

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func TestDownloadPreparerPublishesOnlyFullyVerifiedCandidate(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 18, 0, 0, 0, 0, time.UTC)
	files := map[string]string{
		"/catalog": "catalog", "/manifest": "manifest",
		"/signature": "signature", "/program": "program",
	}
	httpClient := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.Method != http.MethodGet || request.Header.Get("Authorization") != "" ||
			request.Header.Get("Cookie") != "" || request.Header.Get("Referer") != "" {
			t.Errorf("download request leaked identity: %s headers=%v", request.URL, request.Header)
		}
		content, ok := files[request.URL.Path]
		if !ok {
			return &http.Response{StatusCode: http.StatusNotFound, Body: io.NopCloser(strings.NewReader("missing")), Header: make(http.Header)}, nil
		}
		return &http.Response{
			StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(content)), Header: make(http.Header),
		}, nil
	})}
	publicKey, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(t.TempDir(), "state")
	preparer, err := NewDownloadPreparer(DownloadPreparerConfig{
		Root: root, HTTPClient: httpClient, Now: func() time.Time { return now },
		ReleasePublicKeys: map[string]ed25519.PublicKey{"release-key": publicKey},
		Verify: func(config VerifyReleaseFilesConfig) (VerifiedRelease, error) {
			for path, want := range map[string]string{
				config.Paths.Catalog: "catalog", config.Paths.Manifest: "manifest",
				config.Paths.ManifestSignature: "signature", config.Paths.Program: "program",
			} {
				content, err := os.ReadFile(path)
				if err != nil || string(content) != want {
					return VerifiedRelease{}, errors.New("download incomplete")
				}
			}
			return VerifiedRelease{Version: "v0.1.52", Target: "linux-amd64", ProgramSize: 7}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	channel := VerifiedChannel{
		Descriptor: ChannelDescriptor{
			SchemaVersion: 1, Channel: "stable", Target: "linux-amd64",
			Sequence: 7, ExpectedVersion: "v0.1.52",
		},
		Downloads: ChannelDownloads{
			CatalogURL:           "https://release.cos.ap-beijing.myqcloud.com/catalog",
			ManifestURL:          "https://release.cos.ap-beijing.myqcloud.com/manifest",
			ManifestSignatureURL: "https://release.cos.ap-beijing.myqcloud.com/signature",
			ProgramURL:           "https://release.cos.ap-beijing.myqcloud.com/program",
			ExpiresAt:            now.Add(5 * time.Minute),
		},
	}
	candidate, err := preparer.Prepare(context.Background(), channel)
	if err != nil {
		t.Fatal(err)
	}
	if candidate.Version != "v0.1.52" || candidate.Sequence != 7 ||
		candidate.Release.ProgramSize != 7 || !filepath.IsAbs(candidate.Directory) {
		t.Fatalf("candidate = %#v", candidate)
	}
	for _, name := range []string{"release.catalog.json", "manifest.json", "manifest.sig", "vela-computer", "candidate.json"} {
		info, err := os.Lstat(filepath.Join(candidate.Directory, name))
		if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			t.Fatalf("candidate file %s: info=%v err=%v", name, info, err)
		}
	}

	failing, err := NewDownloadPreparer(DownloadPreparerConfig{
		Root: root, HTTPClient: httpClient, Now: func() time.Time { return now },
		ReleasePublicKeys: map[string]ed25519.PublicKey{"release-key": publicKey},
		Verify: func(VerifyReleaseFilesConfig) (VerifiedRelease, error) {
			return VerifiedRelease{}, ErrReleaseInvalid
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	channel.Descriptor.Sequence = 8
	if _, err := failing.Prepare(context.Background(), channel); !errors.Is(err, ErrReleaseInvalid) {
		t.Fatalf("failed verification error = %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "update", "candidates", "00000000000000000008-v0.1.52")); !os.IsNotExist(err) {
		t.Fatalf("failed candidate became visible: %v", err)
	}
}
