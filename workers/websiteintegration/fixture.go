//go:build websiteintegration

// Package websiteintegration exposes a test-only production-deployer constructor
// to the cross-module release/gateway/runtime integration test.
package websiteintegration

import "github.com/lightclaw/tencent-rescue-exporter/internal/website"

var New = website.NewIntegrationFixture
