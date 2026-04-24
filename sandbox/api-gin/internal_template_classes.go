package main

import (
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"cvm-mock-e2b/internal/core"
)

type upsertTemplateClassRequest struct {
	ID                         string                   `json:"id"`
	Name                       string                   `json:"name"`
	Description                string                   `json:"description"`
	WorkloadType               string                   `json:"workload_type"`
	Region                     string                   `json:"region"`
	DefaultPoolSelectionPolicy string                   `json:"default_pool_selection_policy"`
	ResolutionMode             core.ResolutionMode      `json:"resolution_mode"`
	Status                     core.TemplateClassStatus `json:"status"`
	ImportGeneration           int64                    `json:"import_generation"`
	DivergenceMessage          string                   `json:"divergence_message"`
}

type upsertSKURequest struct {
	ID                          string               `json:"id"`
	Name                        string               `json:"name"`
	Description                 string               `json:"description"`
	TemplateClassID             string               `json:"template_class_id"`
	BaseImage                   string               `json:"base_image"`
	DesiredImageID              string               `json:"desired_image_id"`
	StableImageID               string               `json:"stable_image_id"`
	InstanceType                string               `json:"instance_type"`
	NetworkTemplateID           string               `json:"network_template_id"`
	SecurityGroupRuleTemplateID string               `json:"security_group_rule_template_id"`
	AutoscalePolicyID           string               `json:"autoscale_policy_id"`
	DefaultDesiredCapacity      int                  `json:"default_desired_capacity"`
	RolloutState                core.SKURolloutState `json:"rollout_state"`
	RolloutCursorPoolID         string               `json:"rollout_cursor_pool_id"`
	Generation                  int64                `json:"generation"`
	ConvergedPoolCount          int                  `json:"converged_pool_count"`
	TotalPoolCount              int                  `json:"total_pool_count"`
	PoolsPendingRollout         int                  `json:"pools_pending_rollout"`
	LastRolloutError            string               `json:"last_rollout_error"`
}

type upsertTemplateSkuBindingRequest struct {
	SKUID              string `json:"sku_id"`
	Priority           int    `json:"priority"`
	Weight             int    `json:"weight"`
	AdmissionState     string `json:"admission_state"`
	RegionAffinity     string `json:"region_affinity"`
	RolloutEligibility bool   `json:"rollout_eligibility"`
}

type upsertTemplatePoolBindingRequest struct {
	PoolID         string                     `json:"pool_id"`
	Priority       int                        `json:"priority"`
	Weight         int                        `json:"weight"`
	Role           core.PoolBindingRole       `json:"role"`
	AdmissionState core.BindingAdmissionState `json:"admission_state"`
	Reason         string                     `json:"reason"`
}

type upsertPoolAutoscalePolicyRequest struct {
	MinPoolCount             int `json:"min_pool_count"`
	MaxPoolCount             int `json:"max_pool_count"`
	MinCleanPerPool          int `json:"min_clean_per_pool"`
	TargetCleanPerPool       int `json:"target_clean_per_pool"`
	MaxCleanPerPool          int `json:"max_clean_per_pool"`
	WarmBundleTarget         int `json:"warm_bundle_target"`
	SlowHorizonTarget        int `json:"slow_horizon_target"`
	ScaleOutCooldownSeconds  int `json:"scale_out_cooldown_seconds"`
	ScaleInCooldownSeconds   int `json:"scale_in_cooldown_seconds"`
	RefillFailureThreshold   int `json:"refill_failure_threshold"`
	ZoneFailureThreshold     int `json:"zone_failure_threshold"`
	CapacityPressureLimitPct int `json:"capacity_pressure_limit_pct"`
}

type upsertCapacityBundleRequest struct {
	ID                   string                    `json:"id"`
	Region               string                    `json:"region"`
	Zone                 string                    `json:"zone"`
	VpcID                string                    `json:"vpc_id"`
	SubnetID             string                    `json:"subnet_id"`
	SecurityGroupIDs     []string                  `json:"security_group_ids"`
	NetworkTemplateID    string                    `json:"network_template_id"`
	Status               core.CapacityBundleStatus `json:"status"`
	BootstrapGeneration  int                       `json:"bootstrap_generation"`
	LineageTags          map[string]string         `json:"lineage_tags"`
	LastValidationResult string                    `json:"last_validation_result"`
}

func registerTemplateClassRoutes(r gin.IRouter, h *handler) {
	r.GET("/template-classes", h.listTemplateClasses)
	r.POST("/template-classes", h.upsertTemplateClass)
	r.GET("/template-classes/:templateClassID", h.getTemplateClass)
	r.GET("/template-classes/:templateClassID/bindings", h.listTemplateClassBindings)
	r.PUT("/template-classes/:templateClassID/bindings", h.replaceTemplateClassBindings)
	r.GET("/template-classes/:templateClassID/autoscale-policy", h.getTemplateClassAutoscalePolicy)
	r.PUT("/template-classes/:templateClassID/autoscale-policy", h.upsertTemplateClassAutoscalePolicy)
	r.GET("/template-classes/:templateClassID/resolve", h.resolveTemplateClass)
	r.GET("/template-classes/:templateClassID/skus", h.listTemplateClassSKUs)
	r.PUT("/template-classes/:templateClassID/skus", h.replaceTemplateClassSKUs)
	r.GET("/skus", h.listSKUs)
	r.POST("/skus", h.upsertSKU)
	r.GET("/capacity-bundles", h.listCapacityBundles)
	r.POST("/capacity-bundles", h.upsertCapacityBundle)
}

func (h *handler) listTemplateClasses(c *gin.Context) {
	items, err := h.svc.ListTemplateClasses(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, items)
}

func (h *handler) upsertTemplateClass(c *gin.Context) {
	var req upsertTemplateClassRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid body"})
		return
	}
	templateClass, err := h.svc.UpsertTemplateClass(c.Request.Context(), core.TemplateClass{
		ID:                         strings.TrimSpace(req.ID),
		Name:                       strings.TrimSpace(req.Name),
		Description:                strings.TrimSpace(req.Description),
		WorkloadType:               strings.TrimSpace(req.WorkloadType),
		Region:                     strings.TrimSpace(req.Region),
		DefaultPoolSelectionPolicy: strings.TrimSpace(req.DefaultPoolSelectionPolicy),
		ResolutionMode:             req.ResolutionMode,
		Status:                     req.Status,
		ImportGeneration:           req.ImportGeneration,
		DivergenceMessage:          strings.TrimSpace(req.DivergenceMessage),
	})
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, templateClass)
}

func (h *handler) listSKUs(c *gin.Context) {
	items, err := h.svc.ListSKUs(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, items)
}

func (h *handler) upsertSKU(c *gin.Context) {
	var req upsertSKURequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid body"})
		return
	}
	sku, err := h.svc.UpsertSKU(c.Request.Context(), core.SKU{
		ID:                          strings.TrimSpace(req.ID),
		Name:                        strings.TrimSpace(req.Name),
		Description:                 strings.TrimSpace(req.Description),
		TemplateClassID:             strings.TrimSpace(req.TemplateClassID),
		BaseImage:                   strings.TrimSpace(req.BaseImage),
		DesiredImageID:              strings.TrimSpace(req.DesiredImageID),
		StableImageID:               strings.TrimSpace(req.StableImageID),
		InstanceType:                strings.TrimSpace(req.InstanceType),
		NetworkTemplateID:           strings.TrimSpace(req.NetworkTemplateID),
		SecurityGroupRuleTemplateID: strings.TrimSpace(req.SecurityGroupRuleTemplateID),
		AutoscalePolicyID:           strings.TrimSpace(req.AutoscalePolicyID),
		DefaultDesiredCapacity:      req.DefaultDesiredCapacity,
		RolloutState:                req.RolloutState,
		RolloutCursorPoolID:         strings.TrimSpace(req.RolloutCursorPoolID),
		Generation:                  req.Generation,
		ConvergedPoolCount:          req.ConvergedPoolCount,
		TotalPoolCount:              req.TotalPoolCount,
		PoolsPendingRollout:         req.PoolsPendingRollout,
		LastRolloutError:            strings.TrimSpace(req.LastRolloutError),
	})
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, sku)
}

func (h *handler) getTemplateClass(c *gin.Context) {
	templateClassID := strings.TrimSpace(c.Param("templateClassID"))
	templateClass, err := h.svc.GetTemplateClass(c.Request.Context(), templateClassID)
	if err != nil {
		if err == core.ErrTemplateClassNotFound {
			c.JSON(http.StatusNotFound, gin.H{"error": "template class not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, templateClass)
}

func (h *handler) listTemplateClassBindings(c *gin.Context) {
	templateClassID := strings.TrimSpace(c.Param("templateClassID"))
	items, err := h.svc.ListTemplatePoolBindings(c.Request.Context(), templateClassID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, items)
}

func (h *handler) replaceTemplateClassBindings(c *gin.Context) {
	templateClassID := strings.TrimSpace(c.Param("templateClassID"))
	var req []upsertTemplatePoolBindingRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid body"})
		return
	}
	items, err := h.syncTemplateClassBindings(c, templateClassID, req)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, items)
}

func (h *handler) syncTemplateClassBindings(c *gin.Context, templateClassID string, req []upsertTemplatePoolBindingRequest) ([]core.TemplatePoolBinding, error) {
	now := time.Now().UTC()
	items := make([]core.TemplatePoolBinding, 0, len(req))
	for _, item := range req {
		items = append(items, core.TemplatePoolBinding{
			TemplateClassID: templateClassID,
			PoolID:          strings.TrimSpace(item.PoolID),
			Priority:        item.Priority,
			Weight:          item.Weight,
			Role:            item.Role,
			AdmissionState:  item.AdmissionState,
			Reason:          strings.TrimSpace(item.Reason),
			CreatedAt:       now,
		})
	}
	return h.svc.ReplaceTemplatePoolBindings(c.Request.Context(), templateClassID, items)
}

func (h *handler) getTemplateClassAutoscalePolicy(c *gin.Context) {
	templateClassID := strings.TrimSpace(c.Param("templateClassID"))
	policy, err := h.svc.GetPoolAutoscalePolicy(c.Request.Context(), templateClassID)
	if err != nil {
		if err == core.ErrPoolAutoscalePolicyNotFound {
			c.JSON(http.StatusNotFound, gin.H{"error": "pool autoscale policy not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, policy)
}

func (h *handler) upsertTemplateClassAutoscalePolicy(c *gin.Context) {
	templateClassID := strings.TrimSpace(c.Param("templateClassID"))
	var req upsertPoolAutoscalePolicyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid body"})
		return
	}
	policy, err := h.svc.UpsertPoolAutoscalePolicy(c.Request.Context(), core.PoolAutoscalePolicy{
		TemplateClassID:          templateClassID,
		MinPoolCount:             req.MinPoolCount,
		MaxPoolCount:             req.MaxPoolCount,
		MinCleanPerPool:          req.MinCleanPerPool,
		TargetCleanPerPool:       req.TargetCleanPerPool,
		MaxCleanPerPool:          req.MaxCleanPerPool,
		WarmBundleTarget:         req.WarmBundleTarget,
		SlowHorizonTarget:        req.SlowHorizonTarget,
		ScaleOutCooldownSeconds:  req.ScaleOutCooldownSeconds,
		ScaleInCooldownSeconds:   req.ScaleInCooldownSeconds,
		RefillFailureThreshold:   req.RefillFailureThreshold,
		ZoneFailureThreshold:     req.ZoneFailureThreshold,
		CapacityPressureLimitPct: req.CapacityPressureLimitPct,
	})
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, policy)
}

func (h *handler) resolveTemplateClass(c *gin.Context) {
	templateClassID := strings.TrimSpace(c.Param("templateClassID"))
	templateClass, bindings, pools, err := h.svc.ResolveTemplateClassPools(c.Request.Context(), templateClassID)
	if err != nil {
		if err == core.ErrTemplateClassNotFound {
			c.JSON(http.StatusNotFound, gin.H{"error": "template class not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"template_class": templateClass,
		"bindings":       bindings,
		"pools":          pools,
	})
}

func (h *handler) listTemplateClassSKUs(c *gin.Context) {
	templateClassID := strings.TrimSpace(c.Param("templateClassID"))
	items, err := h.svc.ListTemplateSkuBindings(c.Request.Context(), templateClassID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, items)
}

func (h *handler) replaceTemplateClassSKUs(c *gin.Context) {
	templateClassID := strings.TrimSpace(c.Param("templateClassID"))
	var req []upsertTemplateSkuBindingRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid body"})
		return
	}
	now := time.Now().UTC()
	items := make([]core.TemplateSkuBinding, 0, len(req))
	for _, item := range req {
		items = append(items, core.TemplateSkuBinding{
			TemplateClassID:    templateClassID,
			SKUID:              strings.TrimSpace(item.SKUID),
			Priority:           item.Priority,
			Weight:             item.Weight,
			AdmissionState:     strings.TrimSpace(item.AdmissionState),
			RegionAffinity:     strings.TrimSpace(item.RegionAffinity),
			RolloutEligibility: item.RolloutEligibility,
			CreatedAt:          now,
		})
	}
	replaced, err := h.svc.ReplaceTemplateSkuBindings(c.Request.Context(), templateClassID, items)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, replaced)
}

func (h *handler) listCapacityBundles(c *gin.Context) {
	items, err := h.svc.ListCapacityBundles(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, items)
}

func (h *handler) upsertCapacityBundle(c *gin.Context) {
	var req upsertCapacityBundleRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid body"})
		return
	}
	bundle, err := h.svc.UpsertCapacityBundle(c.Request.Context(), core.CapacityBundle{
		ID:                   strings.TrimSpace(req.ID),
		Region:               strings.TrimSpace(req.Region),
		Zone:                 strings.TrimSpace(req.Zone),
		VpcID:                strings.TrimSpace(req.VpcID),
		SubnetID:             strings.TrimSpace(req.SubnetID),
		SecurityGroupIDs:     req.SecurityGroupIDs,
		NetworkTemplateID:    strings.TrimSpace(req.NetworkTemplateID),
		Status:               req.Status,
		BootstrapGeneration:  req.BootstrapGeneration,
		LineageTags:          req.LineageTags,
		LastValidationResult: strings.TrimSpace(req.LastValidationResult),
	})
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, bundle)
}
