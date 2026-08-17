package website

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/tencentyun/cos-go-sdk-v5"
)

func digestForTest(payload string) string {
	sum := sha256.Sum256([]byte(payload))
	return hex.EncodeToString(sum[:])
}

func TestOpenZipEntryExposesLengthToCOSSDK(t *testing.T) {
	archive := websiteZip(t, map[string]string{"index.html": "hello"})
	zr, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		t.Fatal(err)
	}
	reader, size, err := openZipEntryForUpload(zr.File[0])
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	got, err := cos.GetReaderLen(reader)
	if err != nil {
		t.Fatalf("COS SDK cannot determine entry length: %v", err)
	}
	if got != size {
		t.Fatalf("reader length = %d, want %d", got, size)
	}
}

func TestVerifyArtifactUploadAcceptsExactContract(t *testing.T) {
	payload := "verified payload"
	hash := digestForTest(payload)
	f, err := verifyArtifactUpload(strings.NewReader(payload), int64(len(payload)), hash,
		int64(len(payload)), hash, 1024)
	if err != nil {
		t.Fatalf("verifyArtifactUpload: %v", err)
	}
	defer f.Close()
	defer os.Remove(f.Name())
	got, err := io.ReadAll(f)
	if err != nil {
		t.Fatalf("read temp file: %v", err)
	}
	if string(got) != payload {
		t.Fatalf("payload = %q", got)
	}
}

func TestVerifyArtifactUploadRejectsContractMismatch(t *testing.T) {
	payload := "verified payload"
	hash := digestForTest(payload)
	tests := []struct {
		name          string
		contentLength int64
		metadataHash  string
		declaredSize  int64
		declaredHash  string
		maxBytes      int64
	}{
		{"response length", int64(len(payload)) + 1, hash, int64(len(payload)), hash, 1024},
		{"missing metadata", int64(len(payload)), "", int64(len(payload)), hash, 1024},
		{"metadata hash", int64(len(payload)), strings.Repeat("0", 64), int64(len(payload)), hash, 1024},
		{"declared hash", int64(len(payload)), hash, int64(len(payload)), strings.Repeat("0", 64), 1024},
		{"hard limit", int64(len(payload)), hash, int64(len(payload)), hash, int64(len(payload)) - 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := verifyArtifactUpload(strings.NewReader(payload), tt.contentLength, tt.metadataHash,
				tt.declaredSize, tt.declaredHash, tt.maxBytes); err == nil {
				t.Fatal("contract mismatch must fail")
			}
		})
	}
}

func TestVerifyArtifactUploadRejectsActualBodyMismatch(t *testing.T) {
	payload := "verified payload"
	hash := digestForTest(payload)
	if _, err := verifyArtifactUpload(strings.NewReader(payload+"x"), int64(len(payload)), hash,
		int64(len(payload)), hash, 1024); err == nil {
		t.Fatal("body longer than the signed and declared length must fail")
	}
}
