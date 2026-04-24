package routing

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/handler"
	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/crypto"
	"git.woa.com/wisp/mono/ai-gateway/internal/repository"
	"git.woa.com/wisp/mono/ai-gateway/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gorm.io/datatypes"
)

var testEncryptionKey = []byte("01234567890123456789012345678901")

type routingProviderRepo struct {
	providers map[uuid.UUID]*model.Provider
}

func newRoutingProviderRepo() *routingProviderRepo {
	return &routingProviderRepo{providers: make(map[uuid.UUID]*model.Provider)}
}

func (r *routingProviderRepo) Create(provider *model.Provider) error {
	r.providers[provider.ID] = provider
	return nil
}

func (r *routingProviderRepo) GetByID(id uuid.UUID) (*model.Provider, error) {
	provider, ok := r.providers[id]
	if !ok {
		return nil, model.ErrProviderNotFound
	}
	return provider, nil
}

func (r *routingProviderRepo) SelectBest(providerType string) (*model.Provider, error) {
	candidates, err := r.SelectCandidates(providerType)
	if err != nil {
		return nil, err
	}
	if len(candidates) == 0 {
		return nil, model.ErrProviderUnavailable
	}
	return &candidates[0], nil
}

func (r *routingProviderRepo) SelectBestForModel(modelName string) (*model.Provider, error) {
	candidates, err := r.SelectCandidatesForModel(modelName)
	if err != nil {
		return nil, err
	}
	if len(candidates) == 0 {
		return nil, model.ErrProviderUnavailable
	}
	return &candidates[0], nil
}

func (r *routingProviderRepo) SelectCandidatesForModel(modelName string) ([]model.Provider, error) {
	var result []model.Provider
	for _, provider := range r.providers {
		if provider.Status != model.ProviderStatusActive || provider.UsedQuota >= provider.TotalQuota {
			continue
		}
		if supportsModel(provider, modelName) {
			result = append(result, *provider)
		}
	}
	return result, nil
}

func (r *routingProviderRepo) SelectCandidates(providerType string) ([]model.Provider, error) {
	var result []model.Provider
	for _, provider := range r.providers {
		if provider.ProviderType == providerType && provider.Status == model.ProviderStatusActive && provider.UsedQuota < provider.TotalQuota {
			result = append(result, *provider)
		}
	}
	return result, nil
}

func (r *routingProviderRepo) IncrementUsedQuota(providerID uuid.UUID, amount int64) error {
	return nil
}
func (r *routingProviderRepo) MarkExhausted(providerID uuid.UUID) error { return nil }
func (r *routingProviderRepo) IncrementUsedQuotaAndCheckExhaustion(providerID uuid.UUID, amount int64) (bool, error) {
	return false, nil
}
func (r *routingProviderRepo) List() ([]model.Provider, error) {
	var result []model.Provider
	for _, provider := range r.providers {
		result = append(result, *provider)
	}
	return result, nil
}
func (r *routingProviderRepo) Update(provider *model.Provider) error {
	r.providers[provider.ID] = provider
	return nil
}
func (r *routingProviderRepo) UpdateStatus(id uuid.UUID, status string) error { return nil }
func (r *routingProviderRepo) UpdateHeartbeat(id uuid.UUID) error             { return nil }
func (r *routingProviderRepo) Delete(id uuid.UUID) error {
	delete(r.providers, id)
	return nil
}
func (r *routingProviderRepo) FindByBaseURL(baseURL string) (*model.Provider, error) { return nil, nil }
func (r *routingProviderRepo) ListByRegistrationSource(source string) ([]model.Provider, error) {
	return nil, nil
}
func (r *routingProviderRepo) ListForHealthCheck(source string) ([]model.Provider, error) {
	return nil, nil
}
func (r *routingProviderRepo) CountActive() (int64, error) {
	var count int64
	for _, provider := range r.providers {
		if provider.Status == model.ProviderStatusActive {
			count++
		}
	}
	return count, nil
}

type routingMappingRepo struct {
	providers []model.Provider
	mappings  []model.ModelProviderMapping
}

func (m *routingMappingRepo) Create(mapping *model.ModelProviderMapping) error { return nil }
func (m *routingMappingRepo) Update(mapping *model.ModelProviderMapping) error { return nil }
func (m *routingMappingRepo) GetByID(id uuid.UUID) (*model.ModelProviderMapping, error) {
	return nil, nil
}
func (m *routingMappingRepo) Delete(id uuid.UUID) error { return nil }
func (m *routingMappingRepo) ListAll() ([]model.ModelProviderMapping, error) {
	return m.mappings, nil
}
func (m *routingMappingRepo) FindProvidersForModel(modelName string) ([]model.Provider, error) {
	return m.providers, nil
}
func (m *routingMappingRepo) FindMappingsForModel(modelName string) ([]model.ModelProviderMapping, error) {
	return m.mappings, nil
}
func (m *routingMappingRepo) DeleteByProviderID(providerID uuid.UUID) error { return nil }

func mustJSONModels(t *testing.T, models ...string) datatypes.JSON {
	t.Helper()
	data, err := json.Marshal(models)
	if err != nil {
		t.Fatalf("marshal models: %v", err)
	}
	return datatypes.JSON(data)
}

func mustEncryptedKey(t *testing.T, raw string) string {
	t.Helper()
	encrypted, err := crypto.Encrypt(raw, testEncryptionKey)
	if err != nil {
		t.Fatalf("encrypt key: %v", err)
	}
	return encrypted
}

func supportsModel(provider *model.Provider, modelName string) bool {
	if provider == nil || len(provider.SupportedModels) == 0 {
		return false
	}
	var models []string
	if err := json.Unmarshal(provider.SupportedModels, &models); err != nil {
		return false
	}
	for _, candidate := range models {
		if candidate == modelName {
			return true
		}
	}
	return false
}

func TestResolveCandidatesForModel_FiltersMappingMismatch(t *testing.T) {
	provRepo := newRoutingProviderRepo()

	supportedID := uuid.New()
	mismatchID := uuid.New()
	provRepo.providers[supportedID] = &model.Provider{
		ID:              supportedID,
		Name:            "coding-plan",
		ProviderType:    model.ProviderTypeOpenAI,
		APIKey:          mustEncryptedKey(t, "coding-plan-key"),
		Status:          model.ProviderStatusActive,
		TotalQuota:      1000,
		SupportedModels: mustJSONModels(t, "Tencent HY 2.0 Instruct"),
	}
	provRepo.providers[mismatchID] = &model.Provider{
		ID:              mismatchID,
		Name:            "hi",
		ProviderType:    model.ProviderTypeOpenAI,
		APIKey:          mustEncryptedKey(t, "hi-key"),
		Status:          model.ProviderStatusActive,
		TotalQuota:      1000,
		SupportedModels: mustJSONModels(t, "another-model"),
	}

	mappingRepo := &routingMappingRepo{
		providers: []model.Provider{
			*provRepo.providers[supportedID],
			*provRepo.providers[mismatchID],
		},
	}

	svc := service.NewProviderService(provRepo, mappingRepo, testEncryptionKey)

	resolution, err := svc.ResolveCandidatesForModel("Tencent HY 2.0 Instruct")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resolution.Candidates) != 1 {
		t.Fatalf("expected 1 candidate, got %d", len(resolution.Candidates))
	}
	if resolution.Candidates[0].ID != supportedID {
		t.Fatalf("expected supported provider, got %s", resolution.Candidates[0].ID)
	}
	if len(resolution.Mismatches) != 1 {
		t.Fatalf("expected 1 mismatch, got %d", len(resolution.Mismatches))
	}
	if resolution.Mismatches[0].ProviderID != mismatchID {
		t.Fatalf("expected mismatch provider %s, got %s", mismatchID, resolution.Mismatches[0].ProviderID)
	}
}

func TestGetCandidatesForModel_DoesNotFallbackWhenExplicitMappingsMismatch(t *testing.T) {
	provRepo := newRoutingProviderRepo()

	mismatchID := uuid.New()
	fallbackID := uuid.New()
	provRepo.providers[mismatchID] = &model.Provider{
		ID:              mismatchID,
		Name:            "hi",
		ProviderType:    model.ProviderTypeOpenAI,
		APIKey:          mustEncryptedKey(t, "hi-key"),
		Status:          model.ProviderStatusActive,
		TotalQuota:      1000,
		SupportedModels: mustJSONModels(t, "another-model"),
	}
	provRepo.providers[fallbackID] = &model.Provider{
		ID:           fallbackID,
		Name:         "fallback-openai",
		ProviderType: model.ProviderTypeOpenAI,
		APIKey:       mustEncryptedKey(t, "fallback-key"),
		Status:       model.ProviderStatusActive,
		TotalQuota:   1000,
	}

	mappingRepo := &routingMappingRepo{
		providers: []model.Provider{*provRepo.providers[mismatchID]},
	}

	svc := service.NewProviderService(provRepo, mappingRepo, testEncryptionKey)

	_, err := svc.GetCandidatesForModel("Tencent HY 2.0 Instruct")
	if err != model.ErrProviderUnavailable {
		t.Fatalf("expected ErrProviderUnavailable, got %v", err)
	}
}

func TestResolveCandidatesForModel_AllowsMappingWhenSupportedModelsEmpty(t *testing.T) {
	provRepo := newRoutingProviderRepo()

	providerID := uuid.New()
	provRepo.providers[providerID] = &model.Provider{
		ID:           providerID,
		Name:         "legacy-provider",
		ProviderType: model.ProviderTypeOpenAI,
		APIKey:       mustEncryptedKey(t, "legacy-key"),
		Status:       model.ProviderStatusActive,
		TotalQuota:   1000,
	}

	mappingRepo := &routingMappingRepo{
		providers: []model.Provider{*provRepo.providers[providerID]},
	}

	svc := service.NewProviderService(provRepo, mappingRepo, testEncryptionKey)

	resolution, err := svc.ResolveCandidatesForModel("Tencent HY 2.0 Instruct")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resolution.Candidates) != 1 {
		t.Fatalf("expected 1 candidate, got %d", len(resolution.Candidates))
	}
	if resolution.Candidates[0].ID != providerID {
		t.Fatalf("expected mapped provider, got %s", resolution.Candidates[0].ID)
	}
	if len(resolution.Mismatches) != 0 {
		t.Fatalf("expected no mismatches, got %d", len(resolution.Mismatches))
	}
}

func TestResolveCandidatesForModel_UsesSupportedModelsWithoutMappings(t *testing.T) {
	provRepo := newRoutingProviderRepo()

	providerID := uuid.New()
	provRepo.providers[providerID] = &model.Provider{
		ID:              providerID,
		Name:            "supported-only",
		ProviderType:    model.ProviderTypeOpenAI,
		APIKey:          mustEncryptedKey(t, "supported-key"),
		Status:          model.ProviderStatusActive,
		TotalQuota:      1000,
		Priority:        9,
		SupportedModels: mustJSONModels(t, "Tencent HY 2.0 Instruct"),
	}

	svc := service.NewProviderService(provRepo, &routingMappingRepo{}, testEncryptionKey)

	resolution, err := svc.ResolveCandidatesForModel("Tencent HY 2.0 Instruct")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resolution.Candidates) != 1 {
		t.Fatalf("expected 1 candidate, got %d", len(resolution.Candidates))
	}
	if resolution.Candidates[0].ID != providerID {
		t.Fatalf("expected supported_models provider, got %s", resolution.Candidates[0].ID)
	}
}

func TestResolveModel_ReturnsMismatches(t *testing.T) {
	gin.SetMode(gin.TestMode)

	provRepo := newRoutingProviderRepo()
	codingPlanID := uuid.MustParse("11111111-1111-1111-1111-111111111111")
	hiID := uuid.MustParse("22222222-2222-2222-2222-222222222222")
	provRepo.providers[codingPlanID] = &model.Provider{
		ID:              codingPlanID,
		Name:            "coding-plan",
		ProviderType:    model.ProviderTypeOpenAI,
		APIKey:          mustEncryptedKey(t, "coding-plan-key"),
		Status:          model.ProviderStatusActive,
		TotalQuota:      1000,
		BaseURL:         "https://coding-plan.example.com",
		SupportedModels: mustJSONModels(t, "Tencent HY 2.0 Instruct"),
	}
	provRepo.providers[hiID] = &model.Provider{
		ID:              hiID,
		Name:            "hi",
		ProviderType:    model.ProviderTypeOpenAI,
		APIKey:          mustEncryptedKey(t, "hi-key"),
		Status:          model.ProviderStatusActive,
		TotalQuota:      1000,
		BaseURL:         "https://hi.example.com",
		SupportedModels: mustJSONModels(t, "another-model"),
	}

	mappingRepo := &routingMappingRepo{
		providers: []model.Provider{
			*provRepo.providers[codingPlanID],
			*provRepo.providers[hiID],
		},
		mappings: []model.ModelProviderMapping{
			{ID: uuid.New(), ProviderID: codingPlanID, IsActive: true, CreatedAt: time.Now()},
			{ID: uuid.New(), ProviderID: hiID, IsActive: true, CreatedAt: time.Now()},
		},
	}

	providerSvc := service.NewProviderService(provRepo, mappingRepo, testEncryptionKey)
	modelMappingHandler := handler.NewModelMappingHandler(mappingRepo, providerSvc)

	r := gin.New()
	r.GET("/api/admin/model-mappings/resolve", modelMappingHandler.ResolveModel)

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/admin/model-mappings/resolve?model=Tencent%20HY%202.0%20Instruct", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Model     string `json:"model"`
		Count     int    `json:"count"`
		Message   string `json:"message"`
		Providers []struct {
			ID   uuid.UUID `json:"id"`
			Name string    `json:"name"`
		} `json:"providers"`
		Mismatches []struct {
			ProviderID   uuid.UUID `json:"provider_id"`
			ProviderName string    `json:"provider_name"`
			Reason       string    `json:"reason"`
			Source       string    `json:"source"`
		} `json:"mismatches"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	if resp.Model != "Tencent HY 2.0 Instruct" {
		t.Fatalf("expected model in response, got %q", resp.Model)
	}
	if resp.Count != 1 {
		t.Fatalf("expected 1 provider, got %d", resp.Count)
	}
	if len(resp.Providers) != 1 || resp.Providers[0].Name != "coding-plan" {
		t.Fatalf("expected coding-plan provider, got %+v", resp.Providers)
	}
	if len(resp.Mismatches) != 1 {
		t.Fatalf("expected 1 mismatch, got %d", len(resp.Mismatches))
	}
	if resp.Mismatches[0].ProviderName != "hi" {
		t.Fatalf("expected hi mismatch, got %+v", resp.Mismatches[0])
	}
	if resp.Mismatches[0].Source == "" || resp.Mismatches[0].Reason == "" {
		t.Fatalf("expected mismatch source and reason, got %+v", resp.Mismatches[0])
	}
	if resp.Message == "" {
		t.Fatal("expected mismatch message to be set")
	}
}

var _ repository.ProviderRepo = (*routingProviderRepo)(nil)
var _ repository.ModelMappingRepo = (*routingMappingRepo)(nil)
