package handler

import (
	"git.woa.com/wisp/mono/ai-gateway/internal/repository"
	"git.woa.com/wisp/mono/ai-gateway/internal/service"
)

// AdminHandler holds all service references for admin API endpoints.
type AdminHandler struct {
	userSvc      *service.UserService
	planSvc      *service.PlanService
	subSvc       *service.SubscriptionService
	providerSvc  *service.ProviderService
	keySvc       *service.ApiKeyService
	provisionSvc *service.ProvisionService
	usageRepo    repository.UsageRepo
}

// NewAdminHandler creates a new AdminHandler with all required service dependencies.
func NewAdminHandler(
	userSvc *service.UserService,
	planSvc *service.PlanService,
	subSvc *service.SubscriptionService,
	providerSvc *service.ProviderService,
	keySvc *service.ApiKeyService,
	provisionSvc *service.ProvisionService,
	usageRepo repository.UsageRepo,
) *AdminHandler {
	return &AdminHandler{
		userSvc:      userSvc,
		planSvc:      planSvc,
		subSvc:       subSvc,
		providerSvc:  providerSvc,
		keySvc:       keySvc,
		provisionSvc: provisionSvc,
		usageRepo:    usageRepo,
	}
}
