//go:build litestreamvfs && vfs

package meta

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"

	"github.com/benbjohnson/litestream"
	"github.com/superfly/ltx"
)

type countingReplicaClient struct {
	ltxFiles int
	writes   int
}

func (c *countingReplicaClient) Type() string { return "counting" }
func (c *countingReplicaClient) Init(context.Context) error {
	return nil
}
func (c *countingReplicaClient) SetLogger(*slog.Logger) {}
func (c *countingReplicaClient) LTXFiles(context.Context, int, ltx.TXID, bool) (ltx.FileIterator, error) {
	c.ltxFiles++
	return ltx.NewFileInfoSliceIterator([]*ltx.FileInfo{{Level: 0, MinTXID: 1, MaxTXID: 1}}), nil
}
func (c *countingReplicaClient) OpenLTXFile(context.Context, int, ltx.TXID, ltx.TXID, int64, int64) (io.ReadCloser, error) {
	return io.NopCloser(strings.NewReader("")), nil
}
func (c *countingReplicaClient) WriteLTXFile(context.Context, int, ltx.TXID, ltx.TXID, io.Reader) (*ltx.FileInfo, error) {
	c.writes++
	return &ltx.FileInfo{Level: 0, MinTXID: 1, MaxTXID: 1}, nil
}
func (c *countingReplicaClient) DeleteLTXFiles(context.Context, []*ltx.FileInfo) error {
	return nil
}
func (c *countingReplicaClient) DeleteAll(context.Context) error {
	return nil
}

func TestAssumeEmptyReplicaClientSkipsReadsUntilFirstWrite(t *testing.T) {
	base := &countingReplicaClient{}
	wrapped := newAssumeEmptyReplicaClient(base)
	itr, err := wrapped.LTXFiles(context.Background(), 0, 0, false)
	if err != nil {
		t.Fatal(err)
	}
	if itr.Next() {
		t.Fatal("assume-empty wrapper should return no LTX files before first write")
	}
	_ = itr.Close()
	if base.ltxFiles != 0 {
		t.Fatalf("base LTXFiles count=%d want 0", base.ltxFiles)
	}
	if _, err := wrapped.WriteLTXFile(context.Background(), 0, 1, 1, strings.NewReader("x")); err != nil {
		t.Fatal(err)
	}
	itr, err = wrapped.LTXFiles(context.Background(), 0, 0, false)
	if err != nil {
		t.Fatal(err)
	}
	if !itr.Next() {
		t.Fatal("wrapper should delegate LTXFiles after first write")
	}
	_ = itr.Close()
	if base.ltxFiles != 1 {
		t.Fatalf("base LTXFiles count=%d want 1", base.ltxFiles)
	}
}

var _ litestream.ReplicaClient = (*countingReplicaClient)(nil)
