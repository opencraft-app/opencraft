//go:build novfsbackup

package vfs

import (
	"time"

	"github.com/juicedata/juicefs/pkg/meta"
	"github.com/juicedata/juicefs/pkg/object"
	"github.com/prometheus/client_golang/prometheus"
)

var (
	LastBackupTimeG = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "last_successful_backup",
		Help: "Last successful backup.",
	})
	LastBackupDurationG = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "last_backup_duration",
		Help: "Last backup duration.",
	})
)

// Backup is intentionally disabled in Wisp slim builds; metadata durability uses Litestream.
func Backup(meta.Meta, object.ObjectStorage, time.Duration, bool) {
	logger.Warnf("metadata backup is disabled by the novfsbackup build tag")
}
