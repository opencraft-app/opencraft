package workersapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
)

var ErrNoAdmissionCapacity = errors.New("no fresh admitted Cell is available")

// registryPlacement mirrors the private Worker Registry placement record. It
// is never returned from the public /v1 API.
type registryPlacement struct {
	PoolName                string    `json:"pool_name"`
	PoolUID                 string    `json:"pool_uid"`
	SnapshotResourceVersion string    `json:"snapshot_resource_version"`
	SnapshotDigest          string    `json:"snapshot_digest"`
	CellName                string    `json:"cell_name"`
	CellUID                 string    `json:"cell_uid"`
	Datacenter              string    `json:"datacenter"`
	DecidedAt               time.Time `json:"decided_at"`
}

type claimObjectRequest struct {
	Placement *registryPlacement `json:"placement,omitempty"`
}

// PlacementResolver provides a fail-closed, fresh Cell decision for new
// objects. Worker Registry persists the returned decision before Actor
// creation, so this interface is not itself the placement authority.
type PlacementResolver interface {
	Check(context.Context) error
	Resolve(context.Context, string) (registryPlacement, error)
	// AdmissionCandidates returns the same fresh, controller-owned Cell set
	// used for new durable placement. Stateless dispatch consumes this set as
	// an admission lease; CellServingRoute is deliberately not an admission
	// signal because it must remain published for already-placed Objects.
	AdmissionCandidates(context.Context) ([]registryPlacement, error)
}

type staticPlacementResolver struct {
	decision registryPlacement
}

func newStaticPlacementResolver(datacenter string) PlacementResolver {
	return &staticPlacementResolver{decision: registryPlacement{
		PoolName: "test-pool", PoolUID: "test-pool-uid", SnapshotResourceVersion: "1",
		SnapshotDigest: "sha256:" + hex.EncodeToString(make([]byte, sha256.Size)),
		CellName:       "actor-bj-a01", CellUID: "test-cell-uid", Datacenter: datacenter,
		DecidedAt: time.Date(2026, 9, 9, 0, 0, 0, 0, time.UTC),
	}}
}

func (resolver *staticPlacementResolver) Check(context.Context) error { return nil }

func (resolver *staticPlacementResolver) Resolve(context.Context, string) (registryPlacement, error) {
	return resolver.decision, nil
}

func (resolver *staticPlacementResolver) AdmissionCandidates(context.Context) ([]registryPlacement, error) {
	return []registryPlacement{resolver.decision}, nil
}

// qualificationPlacementResolver is deliberately not a production placement
// authority. It lets a not-yet-admitted Cell prove its public /v1 and durable
// storage path without creating the circular dependency of first admitting
// that Cell to the regional ShardPool. The command-line entrypoint requires an
// explicit Cell name, UID, and datacenter, and production manifests never set
// those flags.
type qualificationPlacementResolver struct {
	decision registryPlacement
	now      func() time.Time
}

func NewQualificationPlacementResolver(cellName, cellUID, datacenter string) (PlacementResolver, error) {
	if !namePattern.MatchString(cellName) || !namePattern.MatchString(datacenter) ||
		cellUID == "" || len(cellUID) > 128 || strings.ContainsAny(cellUID, "\x00\r\n") {
		return nil, fmt.Errorf("qualification Cell identity is invalid")
	}
	digest := sha256.Sum256([]byte(cellName + "\x00" + cellUID + "\x00" + datacenter))
	return &qualificationPlacementResolver{
		decision: registryPlacement{
			PoolName: "qualification", PoolUID: "qualification",
			SnapshotResourceVersion: "qualification",
			SnapshotDigest:          "sha256:" + hex.EncodeToString(digest[:]),
			CellName:                cellName,
			CellUID:                 cellUID,
			Datacenter:              datacenter,
		},
		now: func() time.Time { return time.Now().UTC() },
	}, nil
}

func (resolver *qualificationPlacementResolver) Check(context.Context) error { return nil }

func (resolver *qualificationPlacementResolver) Resolve(context.Context, string) (registryPlacement, error) {
	decision := resolver.decision
	decision.DecidedAt = resolver.now()
	return decision, nil
}

func (resolver *qualificationPlacementResolver) AdmissionCandidates(context.Context) ([]registryPlacement, error) {
	decision := resolver.decision
	decision.DecidedAt = resolver.now()
	return []registryPlacement{decision}, nil
}
