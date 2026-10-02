//go:build fdb

package main

import (
	"time"

	"github.com/rivet-dev/rivet/infra/cells/internal/workerregistry"
)

func newFDBMetadataStore(config backendConfig) (workerregistry.MetadataStore, error) {
	return workerregistry.NewFDBMetadataStore(workerregistry.FDBMetadataConfig{
		ClusterFile:        config.fdbClusterFile,
		ConnectionString:   config.fdbConnectionString,
		KeyPrefix:          config.fdbKeyPrefix,
		TransactionTimeout: 5 * time.Second,
	})
}
