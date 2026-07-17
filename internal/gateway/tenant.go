package gateway

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

var ErrInvalidTenantCursor = errors.New("invalid tenant cursor")
var ErrInvalidTenantListOptions = errors.New("invalid tenant list options")
var ErrTenantInactive = errors.New("tenant is not active")
var ErrTenantPending = errors.New("tenant is pending new-api provisioning")

func (s *Service) ListTenants(ctx context.Context, opts TenantListOptions) (TenantListResult, error) {
	opts = normalizeTenantListOptions(opts)
	if err := validateTenantListOptions(opts); err != nil {
		return TenantListResult{}, err
	}
	return s.store.ListTenants(ctx, opts)
}

func (s *Service) EnsureTenantWritable(ctx context.Context, externalUserID string) error {
	return s.ensureTenantCanWrite(ctx, externalUserID)
}

func (s *Service) EnsureTenant(ctx context.Context, tenant Tenant) (Tenant, error) {
	tenant.ExternalUserID = strings.TrimSpace(tenant.ExternalUserID)
	if tenant.ExternalUserID == "" {
		return Tenant{}, errors.New("external user id is required")
	}
	if existing, ok, err := s.store.GetTenant(ctx, tenant.ExternalUserID); err != nil {
		return Tenant{}, err
	} else if ok {
		tenant.CreatedAt = existing.CreatedAt
		if tenant.Backend == "" {
			tenant.Backend = existing.Backend
		}
		if tenant.SetID == "" {
			tenant.SetID = existing.SetID
		}
		if tenant.Status == "" {
			tenant.Status = existing.Status
		}
		if tenant.Source == "" {
			tenant.Source = existing.Source
		}
		if tenant.DisplayName == "" {
			tenant.DisplayName = existing.DisplayName
		}
	}
	if err := s.store.SaveTenant(ctx, tenant); err != nil {
		return Tenant{}, err
	}
	saved, ok, err := s.store.GetTenant(ctx, tenant.ExternalUserID)
	if err != nil {
		return Tenant{}, err
	}
	if !ok {
		return normalizeTenant(tenant)
	}
	return saved, nil
}

func normalizeTenantListOptions(opts TenantListOptions) TenantListOptions {
	opts.Keyword = strings.TrimSpace(opts.Keyword)
	opts.Backend = strings.TrimSpace(opts.Backend)
	opts.SetID = strings.TrimSpace(opts.SetID)
	opts.Status = strings.TrimSpace(strings.ToLower(opts.Status))
	opts.Cursor = strings.TrimSpace(opts.Cursor)
	if opts.Limit <= 0 {
		opts.Limit = 50
	}
	if opts.Limit > 200 {
		opts.Limit = 200
	}
	if opts.Offset < 0 {
		opts.Offset = 0
	}
	if opts.Cursor != "" {
		opts.Offset = 0
	}
	return opts
}

func validateTenantListOptions(opts TenantListOptions) error {
	if opts.Keyword != "" && (opts.Backend != "" || opts.SetID != "") {
		return fmt.Errorf("%w: keyword cannot be combined with backend or set_id", ErrInvalidTenantListOptions)
	}
	return nil
}

func normalizeTenant(tenant Tenant) (Tenant, error) {
	tenant.ExternalUserID = strings.TrimSpace(tenant.ExternalUserID)
	tenant.Backend = strings.TrimSpace(strings.ToLower(tenant.Backend))
	tenant.SetID = strings.TrimSpace(tenant.SetID)
	tenant.Status = strings.TrimSpace(strings.ToLower(tenant.Status))
	tenant.Source = strings.TrimSpace(tenant.Source)
	tenant.DisplayName = strings.TrimSpace(tenant.DisplayName)
	if tenant.ExternalUserID == "" {
		return Tenant{}, errors.New("external user id is required")
	}
	if tenant.Backend == "" {
		tenant.Backend = UserBackendPending
	}
	switch tenant.Backend {
	case UserBackendPending:
		tenant.SetID = ""
	case UserBackendNew:
		if tenant.SetID == "" {
			return Tenant{}, errors.New("tenant set_id is required for backend=new")
		}
	default:
		return Tenant{}, errors.New("invalid tenant backend")
	}
	if tenant.Status == "" {
		tenant.Status = TenantStatusActive
	}
	switch tenant.Status {
	case TenantStatusActive, TenantStatusDisabled, TenantStatusDeleting, TenantStatusDeleted:
	default:
		return Tenant{}, errors.New("invalid tenant status")
	}
	return tenant, nil
}

func tenantIsActive(tenant Tenant) bool {
	return strings.TrimSpace(strings.ToLower(tenant.Status)) == TenantStatusActive
}

func (s *Service) ensureTenantCanWrite(ctx context.Context, externalUserID string) error {
	tenant, ok, err := s.store.GetTenant(ctx, strings.TrimSpace(externalUserID))
	if err != nil || !ok {
		return err
	}
	if tenantIsActive(tenant) {
		return nil
	}
	return fmtInactiveTenant(tenant)
}

func (s *Service) ensureTenantCanUseTraffic(ctx context.Context, externalUserID string) error {
	tenant, ok, err := s.store.GetTenant(ctx, strings.TrimSpace(externalUserID))
	if err != nil || !ok {
		return err
	}
	if tenant.Backend == UserBackendPending {
		return ErrTenantPending
	}
	if tenantIsActive(tenant) {
		return nil
	}
	return fmtInactiveTenant(tenant)
}

func fmtInactiveTenant(tenant Tenant) error {
	status := strings.TrimSpace(tenant.Status)
	if status == "" {
		status = TenantStatusDisabled
	}
	return fmt.Errorf("%w: tenant %s is %s", ErrTenantInactive, tenant.ExternalUserID, status)
}

func buildTenantSummary(tenant Tenant, binding UserBinding, assignment UserAssignment, observation TenantObservation, keyCount int) TenantSummary {
	tenant, _ = normalizeTenant(tenant)
	item := TenantSummary{
		UserID:           tenant.ExternalUserID,
		Backend:          tenant.Backend,
		SetID:            tenant.SetID,
		Status:           tenant.Status,
		Source:           tenant.Source,
		DisplayName:      tenant.DisplayName,
		KeyCount:         keyCount,
		AssignmentStatus: "tenant",
		CreatedAt:        tenant.CreatedAt,
		UpdatedAt:        tenant.UpdatedAt,
	}
	if binding.ExternalUserID != "" {
		binding = normalizeUserBinding(binding)
		item.UpstreamUserID = binding.UpstreamUserID
		item.Username = binding.Username
		item.LastPlanID = binding.LastPlanID
		item.ProvisionStatus = binding.ProvisionStatus
		item.LastProvisionError = binding.LastProvisionError
		if item.SetID == "" && item.Backend == UserBackendNew {
			item.SetID = binding.SetID
		}
		if assignment.ExternalUserID == "" {
			item.AssignmentStatus = "bound_unassigned"
		}
	}
	if assignment.ExternalUserID != "" {
		item.AssignmentStatus = "explicit"
		item.MigratedAt = assignment.MigratedAt
		if item.SetID == "" && assignment.SetID != "" {
			item.SetID = assignment.SetID
		}
	}
	if observation.ExternalUserID != "" {
		item.ObservedPlanID = observation.CurrentPlanID
		item.ObservedCreditAvailable = observation.CreditAvailable
		item.ObservedCreditStatus = observation.CreditStatus
		item.ObservedSubscriptionStatus = observation.SubscriptionStatus
		item.ObservedAt = observation.ObservedAt
	}
	return item
}

func tenantMatchesOptions(item TenantSummary, opts TenantListOptions) bool {
	if opts.Status == "" && item.Status == TenantStatusDeleted {
		return false
	}
	if opts.Status != "" && item.Status != opts.Status {
		return false
	}
	if opts.Backend != "" && item.Backend != opts.Backend {
		return false
	}
	if opts.SetID != "" && item.SetID != opts.SetID {
		return false
	}
	return true
}

type tenantListCursor struct {
	Version    int    `json:"v"`
	Kind       string `json:"kind"`
	FilterHash string `json:"filter"`
	Phase      string `json:"phase,omitempty"`
	UpdatedAt  string `json:"updated_at,omitempty"`
	UserID     string `json:"user_id,omitempty"`
	Username   string `json:"username,omitempty"`
}

const (
	tenantCursorVersion       = 2
	tenantCursorKindInventory = "inventory"
	tenantCursorKindSearch    = "search"
	tenantSearchPhaseUserID   = "user_id"
	tenantSearchPhaseUsername = "username"
)

func encodeTenantInventoryCursor(item TenantSummary, opts TenantListOptions) string {
	return encodeTenantListCursor(tenantListCursor{
		Version:    tenantCursorVersion,
		Kind:       tenantCursorKindInventory,
		FilterHash: tenantListFilterHash(opts),
		UpdatedAt:  item.UpdatedAt.UTC().Format(time.RFC3339Nano),
		UserID:     item.UserID,
	})
}

func encodeTenantSearchCursor(item TenantSummary, opts TenantListOptions) string {
	phase := tenantSearchPhaseUserID
	username := ""
	if !tenantValueMatchesSearch(item.UserID, opts.Keyword) {
		phase = tenantSearchPhaseUsername
		username = item.Username
	}
	return encodeTenantListCursor(tenantListCursor{
		Version:    tenantCursorVersion,
		Kind:       tenantCursorKindSearch,
		FilterHash: tenantListFilterHash(opts),
		Phase:      phase,
		UserID:     item.UserID,
		Username:   username,
	})
}

func encodeTenantSearchPhaseStart(opts TenantListOptions, phase string) string {
	return encodeTenantListCursor(tenantListCursor{
		Version:    tenantCursorVersion,
		Kind:       tenantCursorKindSearch,
		FilterHash: tenantListFilterHash(opts),
		Phase:      phase,
	})
}

func encodeTenantListCursor(cursor tenantListCursor) string {
	raw, err := json.Marshal(cursor)
	if err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

func decodeTenantCursor(raw string, opts TenantListOptions) (tenantListCursor, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(raw))
	if err != nil {
		return tenantListCursor{}, ErrInvalidTenantCursor
	}
	var cursor tenantListCursor
	if err := json.Unmarshal(decoded, &cursor); err != nil {
		return tenantListCursor{}, ErrInvalidTenantCursor
	}
	expectedKind := tenantCursorKindInventory
	if opts.Keyword != "" {
		expectedKind = tenantCursorKindSearch
	}
	if cursor.Version != tenantCursorVersion || cursor.Kind != expectedKind || cursor.FilterHash != tenantListFilterHash(opts) {
		return tenantListCursor{}, ErrInvalidTenantCursor
	}
	if cursor.Kind == tenantCursorKindInventory {
		if _, err := cursor.inventoryUpdatedAt(); err != nil || cursor.UserID == "" {
			return tenantListCursor{}, ErrInvalidTenantCursor
		}
		return cursor, nil
	}
	if cursor.Phase != tenantSearchPhaseUserID && cursor.Phase != tenantSearchPhaseUsername {
		return tenantListCursor{}, ErrInvalidTenantCursor
	}
	if cursor.Phase == tenantSearchPhaseUserID && cursor.Username != "" {
		return tenantListCursor{}, ErrInvalidTenantCursor
	}
	if cursor.Phase == tenantSearchPhaseUsername && (cursor.UserID == "") != (cursor.Username == "") {
		return tenantListCursor{}, ErrInvalidTenantCursor
	}
	return cursor, nil
}

func (c tenantListCursor) inventoryUpdatedAt() (time.Time, error) {
	updatedAt, err := time.Parse(time.RFC3339Nano, c.UpdatedAt)
	if err != nil {
		return time.Time{}, ErrInvalidTenantCursor
	}
	return updatedAt.UTC(), nil
}

func tenantListFilterHash(opts TenantListOptions) string {
	value := strings.Join([]string{opts.Keyword, opts.Backend, opts.SetID, opts.Status}, "\x00")
	sum := sha256.Sum256([]byte(value))
	return fmt.Sprintf("%x", sum[:12])
}

func tenantValueMatchesSearch(value string, keyword string) bool {
	if len(keyword) <= 2 {
		return value == keyword
	}
	return strings.HasPrefix(value, keyword)
}

func tenantAfterInventoryCursor(item TenantSummary, updatedAt time.Time, userID string) bool {
	itemUpdatedAt := item.UpdatedAt.UTC()
	if itemUpdatedAt.Before(updatedAt) {
		return true
	}
	return itemUpdatedAt.Equal(updatedAt) && item.UserID < userID
}

func earliestNonZeroTime(a, b time.Time) time.Time {
	if a.IsZero() {
		return b
	}
	if b.IsZero() || a.Before(b) {
		return a
	}
	return b
}

func latestNonZeroTime(a, b time.Time) time.Time {
	if a.IsZero() {
		return b
	}
	if b.IsZero() || a.After(b) {
		return a
	}
	return b
}
