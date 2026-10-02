//go:build !fdb

package main

import (
	"fmt"

	"github.com/rivet-dev/rivet/infra/cells/internal/workerregistry"
)

func newFDBMetadataStore(_ backendConfig) (workerregistry.MetadataStore, error) {
	return nil, fmt.Errorf("this Worker registry binary was built without FoundationDB support")
}
