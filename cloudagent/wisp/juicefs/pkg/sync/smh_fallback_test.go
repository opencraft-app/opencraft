package sync

import (
	"bytes"
	"context"
	"testing"

	"github.com/juicedata/juicefs/pkg/object"
)

type multipartNoCopyWrapper struct {
	object.ObjectStorage
}

func (w *multipartNoCopyWrapper) Limits() object.Limits {
	l := w.ObjectStorage.Limits()
	l.IsSupportMultipartUpload = true
	l.IsSupportUploadPartCopy = false
	l.MinPartSize = 1
	l.MaxPartSize = 1 << 20
	l.MaxPartCount = 10000
	return l
}

func TestCopyDataFallsBackWithoutUploadPartCopy(t *testing.T) {
	InitForCopyData()
	src, _ := object.CreateStorage("mem", "", "", "", "")
	dstBase, _ := object.CreateStorage("mem", "", "", "", "")
	dst := &multipartNoCopyWrapper{ObjectStorage: dstBase}

	key := "large-object"
	content := bytes.Repeat([]byte("x"), 40<<20)
	if err := src.Put(context.Background(), key, bytes.NewReader(content)); err != nil {
		t.Fatal(err)
	}
	if _, err := CopyData(src, dst, key, int64(len(content)), false); err != nil {
		t.Fatal(err)
	}
	rc, err := dst.Get(context.Background(), key, 0, -1)
	if err != nil {
		t.Fatal(err)
	}
	defer rc.Close()
	got := new(bytes.Buffer)
	if _, err := got.ReadFrom(rc); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got.Bytes(), content) {
		t.Fatal("copied content mismatch")
	}
}
