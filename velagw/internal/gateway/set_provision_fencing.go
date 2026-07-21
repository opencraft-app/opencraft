package gateway

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"strings"
	"time"
)

type setProvisionClaimStoreInput struct {
	ID                string
	RuntimeBackend    string
	WriterEpoch       int64
	LifecycleRevision int64
	Owner             string
	Token             string
	Now               time.Time
	LeaseUntil        time.Time
}

type setProvisionFactCommitStoreInput struct {
	ID                    string
	RuntimeBackend        string
	WriterEpoch           int64
	LifecycleRevision     int64
	ExpectedStatus        string
	ExpectedVersion       int64
	ClaimToken            string
	NextStatus            string
	CRUID                 string
	CRGeneration          int64
	RuntimeSecretUID      string
	RuntimeIdentityDigest string
	BootstrapJobUID       string
	BootstrapCompletedAt  time.Time
	Fact                  SetReconcileFact
	Now                   time.Time
}

type setProvisionLeaseStoreInput struct {
	ID                string
	RuntimeBackend    string
	WriterEpoch       int64
	LifecycleRevision int64
	ExpectedVersion   int64
	ClaimToken        string
	Now               time.Time
	LeaseUntil        time.Time
}

type setProvisionFactAdvanceStoreInput struct {
	ID                string
	RuntimeBackend    string
	WriterEpoch       int64
	LifecycleRevision int64
	ExpectedStatus    string
	ExpectedVersion   int64
	FactHash          string
	NextStatus        string
	Now               time.Time
}

func (s *Service) ClaimSetProvisionRequest(ctx context.Context, input SetProvisionClaimInput) (SetProvisionRequest, bool, error) {
	input.ID = strings.TrimSpace(input.ID)
	input.RuntimeBackend = strings.TrimSpace(strings.ToLower(input.RuntimeBackend))
	input.Owner = strings.TrimSpace(input.Owner)
	if input.ID == "" || input.Owner == "" {
		return SetProvisionRequest{}, false, fmt.Errorf("request id and owner are required")
	}
	if input.RuntimeBackend != SetRuntimeBackendVelaGWSet {
		return SetProvisionRequest{}, false, fmt.Errorf("unsupported provision backend %q", input.RuntimeBackend)
	}
	if input.WriterEpoch <= 0 || input.LifecycleRevision <= 0 {
		return SetProvisionRequest{}, false, fmt.Errorf("writer epoch and lifecycle revision must be positive")
	}
	if input.LeaseTTL <= 0 {
		input.LeaseTTL = time.Minute
	}
	token, err := newProvisionClaimToken()
	if err != nil {
		return SetProvisionRequest{}, false, err
	}
	now := s.nowUTC()
	return s.store.ClaimSetProvisionRequest(ctx, setProvisionClaimStoreInput{
		ID: input.ID, RuntimeBackend: input.RuntimeBackend, WriterEpoch: input.WriterEpoch,
		LifecycleRevision: input.LifecycleRevision, Owner: input.Owner, Token: token,
		Now: now, LeaseUntil: now.Add(input.LeaseTTL),
	})
}

func (s *Service) RenewSetProvisionClaim(ctx context.Context, input SetProvisionLeaseInput) (SetProvisionRequest, bool, error) {
	storeInput, err := s.buildSetProvisionLeaseStoreInput(input, true)
	if err != nil {
		return SetProvisionRequest{}, false, err
	}
	return s.store.RenewSetProvisionClaim(ctx, storeInput)
}

func (s *Service) ReleaseSetProvisionClaim(ctx context.Context, input SetProvisionLeaseInput) (SetProvisionRequest, bool, error) {
	storeInput, err := s.buildSetProvisionLeaseStoreInput(input, false)
	if err != nil {
		return SetProvisionRequest{}, false, err
	}
	return s.store.ReleaseSetProvisionClaim(ctx, storeInput)
}

func (s *Service) buildSetProvisionLeaseStoreInput(input SetProvisionLeaseInput, renew bool) (setProvisionLeaseStoreInput, error) {
	input.ID = strings.TrimSpace(input.ID)
	input.RuntimeBackend = strings.TrimSpace(strings.ToLower(input.RuntimeBackend))
	input.ClaimToken = strings.TrimSpace(input.ClaimToken)
	if input.ID == "" || input.ClaimToken == "" {
		return setProvisionLeaseStoreInput{}, fmt.Errorf("request id and claim token are required")
	}
	if input.RuntimeBackend != SetRuntimeBackendVelaGWSet {
		return setProvisionLeaseStoreInput{}, fmt.Errorf("unsupported provision backend %q", input.RuntimeBackend)
	}
	if input.WriterEpoch <= 0 || input.LifecycleRevision <= 0 || input.ExpectedVersion <= 0 {
		return setProvisionLeaseStoreInput{}, fmt.Errorf("writer epoch, lifecycle revision, and expected version must be positive")
	}
	if renew && input.LeaseTTL <= 0 {
		input.LeaseTTL = time.Minute
	}
	now := s.nowUTC()
	return setProvisionLeaseStoreInput{
		ID: input.ID, RuntimeBackend: input.RuntimeBackend, WriterEpoch: input.WriterEpoch,
		LifecycleRevision: input.LifecycleRevision, ExpectedVersion: input.ExpectedVersion,
		ClaimToken: input.ClaimToken, Now: now, LeaseUntil: now.Add(input.LeaseTTL),
	}, nil
}

func (s *Service) CommitSetProvisionFact(ctx context.Context, input SetProvisionFactCommitInput) (SetProvisionRequest, bool, error) {
	request, ok, err := s.store.GetSetProvisionRequest(ctx, strings.TrimSpace(input.ID))
	if err != nil || !ok {
		return SetProvisionRequest{}, false, err
	}
	fact, err := s.buildSetReconcileFact(ctx, request.Source, request.Namespace, request.Fleet, input.Fact)
	if err != nil {
		return SetProvisionRequest{}, false, err
	}
	return s.store.CommitSetProvisionFact(ctx, setProvisionFactCommitStoreInput{
		ID: input.ID, RuntimeBackend: input.RuntimeBackend, WriterEpoch: input.WriterEpoch,
		LifecycleRevision: input.LifecycleRevision, ExpectedStatus: input.ExpectedStatus,
		ExpectedVersion: input.ExpectedVersion, ClaimToken: input.ClaimToken, NextStatus: input.NextStatus,
		CRUID: input.CRUID, CRGeneration: input.CRGeneration, RuntimeSecretUID: input.RuntimeSecretUID,
		RuntimeIdentityDigest: input.RuntimeIdentityDigest, BootstrapJobUID: input.BootstrapJobUID,
		BootstrapCompletedAt: input.BootstrapCompletedAt, Fact: fact, Now: s.nowUTC(),
	})
}

func (s *Service) advanceNativeProvisionRequestForManagedFact(ctx context.Context, fact SetReconcileFact) error {
	if fact.Status != SetReconcileStatusManaged || strings.TrimSpace(fact.DesiredHash) == "" {
		return nil
	}
	requests, err := s.store.ListSetProvisionRequests(ctx, SetProvisionRequestListOptions{
		Source: fact.Source, Namespace: fact.Namespace, Fleet: fact.Fleet, SetID: fact.SetID,
		RuntimeBackend: SetRuntimeBackendVelaGWSet, Limit: 1,
	})
	if err != nil || len(requests) == 0 {
		return err
	}
	request := requests[0]
	nextStatus := ""
	switch {
	case request.Status == SetProvisionStatusCreated && fact.RuntimeGeneration == 0 && request.AdminFactHash == fact.DesiredHash:
		nextStatus = SetProvisionStatusConfigured
	case request.Status == SetProvisionStatusConfigured && fact.RuntimeGeneration > 0 && request.ServingFactHash == fact.DesiredHash:
		nextStatus = SetProvisionStatusManaged
	default:
		return nil
	}
	_, advanced, err := s.store.AdvanceSetProvisionRequestForFact(ctx, setProvisionFactAdvanceStoreInput{
		ID: request.ID, RuntimeBackend: request.RuntimeBackend, WriterEpoch: request.WriterEpoch,
		LifecycleRevision: request.LifecycleRevision, ExpectedStatus: request.Status,
		ExpectedVersion: request.Version, FactHash: fact.DesiredHash, NextStatus: nextStatus, Now: s.nowUTC(),
	})
	if err != nil {
		return err
	}
	if !advanced {
		return nil
	}
	return nil
}

func newProvisionClaimToken() (string, error) {
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate provision claim token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func (s *MemoryStore) ClaimSetProvisionRequest(_ context.Context, input setProvisionClaimStoreInput) (SetProvisionRequest, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	request, ok := s.setRequests[input.ID]
	if !ok || request.RuntimeBackend != input.RuntimeBackend || request.WriterEpoch != input.WriterEpoch || request.LifecycleRevision != input.LifecycleRevision {
		return SetProvisionRequest{}, false, nil
	}
	if request.Status != SetProvisionStatusPending && request.Status != SetProvisionStatusProvisioning && request.Status != SetProvisionStatusConfigured {
		return request, false, nil
	}
	if request.ClaimToken != "" && request.ClaimLeaseUntil.After(input.Now) {
		return request, false, nil
	}
	if request.Status == SetProvisionStatusPending {
		request.Status = SetProvisionStatusProvisioning
		request.Attempt++
		request.LastStatusAt = input.Now
	}
	request.ClaimOwner = input.Owner
	request.ClaimToken = input.Token
	request.ClaimLeaseUntil = input.LeaseUntil
	request.Version++
	request.UpdatedAt = input.Now
	s.setRequests[request.ID] = request
	return request, true, nil
}

func (s *MemoryStore) RenewSetProvisionClaim(_ context.Context, input setProvisionLeaseStoreInput) (SetProvisionRequest, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	request, ok := s.setRequests[input.ID]
	if !ok || !setProvisionLeaseMatches(request, input) || !request.ClaimLeaseUntil.After(input.Now) {
		return request, false, nil
	}
	request.ClaimLeaseUntil = input.LeaseUntil
	request.UpdatedAt = input.Now
	s.setRequests[request.ID] = request
	return request, true, nil
}

func (s *MemoryStore) ReleaseSetProvisionClaim(_ context.Context, input setProvisionLeaseStoreInput) (SetProvisionRequest, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	request, ok := s.setRequests[input.ID]
	if !ok || !setProvisionLeaseMatches(request, input) {
		return request, false, nil
	}
	request.ClaimOwner = ""
	request.ClaimToken = ""
	request.ClaimLeaseUntil = time.Time{}
	request.Version++
	request.UpdatedAt = input.Now
	s.setRequests[request.ID] = request
	return request, true, nil
}

func setProvisionLeaseMatches(request SetProvisionRequest, input setProvisionLeaseStoreInput) bool {
	return request.RuntimeBackend == input.RuntimeBackend && request.WriterEpoch == input.WriterEpoch &&
		request.LifecycleRevision == input.LifecycleRevision && request.Version == input.ExpectedVersion &&
		request.ClaimToken != "" && request.ClaimToken == input.ClaimToken
}

func (s *MemoryStore) CommitSetProvisionFact(_ context.Context, input setProvisionFactCommitStoreInput) (SetProvisionRequest, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	request, ok := s.setRequests[input.ID]
	if !ok || request.RuntimeBackend != input.RuntimeBackend || request.WriterEpoch != input.WriterEpoch ||
		request.LifecycleRevision != input.LifecycleRevision || request.Status != input.ExpectedStatus ||
		request.Version != input.ExpectedVersion || request.ClaimToken == "" || request.ClaimToken != input.ClaimToken ||
		!request.ClaimLeaseUntil.After(input.Now) {
		return request, false, nil
	}
	request.Status = input.NextStatus
	request.CRUID = firstNonEmpty(input.CRUID, request.CRUID)
	if input.CRGeneration > 0 {
		request.CRGeneration = input.CRGeneration
	}
	request.RuntimeSecretUID = firstNonEmpty(input.RuntimeSecretUID, request.RuntimeSecretUID)
	request.RuntimeIdentityDigest = firstNonEmpty(input.RuntimeIdentityDigest, request.RuntimeIdentityDigest)
	request.BootstrapJobUID = firstNonEmpty(input.BootstrapJobUID, request.BootstrapJobUID)
	if !input.BootstrapCompletedAt.IsZero() {
		request.BootstrapCompletedAt = input.BootstrapCompletedAt
	}
	if input.Fact.RuntimeGeneration > 0 {
		request.ServingFactHash = input.Fact.DesiredHash
	} else {
		request.AdminFactHash = input.Fact.DesiredHash
	}
	request.ClaimOwner = ""
	request.ClaimToken = ""
	request.ClaimLeaseUntil = time.Time{}
	request.LastStatusAt = input.Now
	request.UpdatedAt = input.Now
	request.Version++
	s.setRequests[request.ID] = request

	fact := input.Fact
	key := setReconcileFactKey(fact.Source, fact.Namespace, fact.Fleet, fact.SetID)
	if existing, exists := s.setFacts[key]; exists {
		fact.CreatedAt = existing.CreatedAt
	} else if fact.CreatedAt.IsZero() {
		fact.CreatedAt = input.Now
	}
	if fact.LastObservedAt.IsZero() {
		fact.LastObservedAt = input.Now
	}
	fact.UpdatedAt = input.Now
	s.setFacts[key] = fact
	return request, true, nil
}

func (s *MemoryStore) AdvanceSetProvisionRequestForFact(_ context.Context, input setProvisionFactAdvanceStoreInput) (SetProvisionRequest, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	request, ok := s.setRequests[input.ID]
	if !ok || request.RuntimeBackend != input.RuntimeBackend || request.WriterEpoch != input.WriterEpoch ||
		request.LifecycleRevision != input.LifecycleRevision || request.Status != input.ExpectedStatus || request.Version != input.ExpectedVersion {
		return request, false, nil
	}
	expectedHash := request.AdminFactHash
	if input.NextStatus == SetProvisionStatusManaged {
		expectedHash = request.ServingFactHash
	}
	if expectedHash == "" || expectedHash != input.FactHash {
		return request, false, nil
	}
	request.Status = input.NextStatus
	request.Version++
	request.LastStatusAt = input.Now
	request.UpdatedAt = input.Now
	s.setRequests[request.ID] = request
	return request, true, nil
}
