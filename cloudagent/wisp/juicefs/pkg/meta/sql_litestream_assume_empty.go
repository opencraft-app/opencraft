//go:build litestreamvfs && vfs

package meta

import (
	"context"
	"io"
	"sync/atomic"

	"github.com/benbjohnson/litestream"
	"github.com/superfly/ltx"
)

type assumeEmptyReplicaClient struct {
	litestream.ReplicaClient
	written atomic.Bool
}

func newAssumeEmptyReplicaClient(client litestream.ReplicaClient) litestream.ReplicaClient {
	return &assumeEmptyReplicaClient{ReplicaClient: client}
}

func (c *assumeEmptyReplicaClient) LTXFiles(ctx context.Context, level int, seek ltx.TXID, useMetadata bool) (ltx.FileIterator, error) {
	if !c.written.Load() {
		return ltx.NewFileInfoSliceIterator(nil), nil
	}
	return c.ReplicaClient.LTXFiles(ctx, level, seek, useMetadata)
}

func (c *assumeEmptyReplicaClient) WriteLTXFile(ctx context.Context, level int, minTXID, maxTXID ltx.TXID, r io.Reader) (*ltx.FileInfo, error) {
	info, err := c.ReplicaClient.WriteLTXFile(ctx, level, minTXID, maxTXID, r)
	if err == nil {
		c.written.Store(true)
	}
	return info, err
}
