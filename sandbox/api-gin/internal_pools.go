package main

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"cvm-mock-e2b/internal/core"
)

type patchPoolRequest struct {
	Name           *string          `json:"name"`
	Description    *string          `json:"description"`
	BaseImage      *string          `json:"base_image"`
	MarkCleanAsDry bool             `json:"mark_clean_as_dry"`
	DesiredCapcity *int             `json:"desired_capacity"`
	InstanceType   *string          `json:"instance_type"`
	Status         *core.PoolStatus `json:"status"`
	PauseReason    *string          `json:"pause_reason"`
	VpcID          *string          `json:"vpc_id"`
	SubnetID       *string          `json:"subnet_id"`
	Zone           *string          `json:"zone"`
	SecurityGroups *[]string        `json:"security_groups"`
}

type createPoolRequest struct {
	Name           string           `json:"name"`
	Description    string           `json:"description"`
	BaseImage      string           `json:"base_image"`
	DesiredCapcity int              `json:"desired_capacity"`
	InstanceType   string           `json:"instance_type"`
	Status         core.PoolStatus  `json:"status"`
	PauseReason    string           `json:"pause_reason"`
	VpcID          string           `json:"vpc_id"`
	SubnetID       string           `json:"subnet_id"`
	Zone           string           `json:"zone"`
	SecurityGroups []string         `json:"security_groups"`
}

func registerPoolRoutes(r gin.IRouter, h *handler) {
	r.GET("/pools", h.listPools)
	r.POST("/pools", h.createPool)
	r.PATCH("/pools/:poolID", h.patchPool)
	r.GET("/pools/:poolID/instances", h.listPoolInstances)
}

func (h *handler) listPools(c *gin.Context) {
	pools, err := h.svc.ListPools(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, pools)
}

func (h *handler) listPoolInstances(c *gin.Context) {
	poolID := strings.TrimSpace(c.Param("poolID"))
	items, err := h.svc.ListInstances(c.Request.Context(), poolID)
	if err != nil {
		if err == core.ErrPoolNotFound {
			c.JSON(http.StatusNotFound, gin.H{"error": "pool not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, items)
}

func (h *handler) createPool(c *gin.Context) {
	var req createPoolRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid body"})
		return
	}

	pool, err := h.svc.CreatePool(
		c.Request.Context(),
		strings.TrimSpace(req.Name),
		strings.TrimSpace(req.Description),
		strings.TrimSpace(req.BaseImage),
		req.DesiredCapcity,
		strings.TrimSpace(req.VpcID),
		strings.TrimSpace(req.SubnetID),
		strings.TrimSpace(req.Zone),
		req.SecurityGroups,
	)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	needsUpdate := false
	if trimmed := strings.TrimSpace(req.InstanceType); trimmed != "" {
		pool.InstanceType = trimmed
		needsUpdate = true
	}
	if req.Status != "" {
		pool.Status = req.Status
		needsUpdate = true
	}
	if trimmed := strings.TrimSpace(req.PauseReason); trimmed != "" {
		pool.PauseReason = trimmed
		needsUpdate = true
	}
	if needsUpdate {
		pool, err = h.svc.UpdatePool(c.Request.Context(), pool)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
	}

	c.JSON(http.StatusCreated, pool)
}

func (h *handler) patchPool(c *gin.Context) {
	poolID := strings.TrimSpace(c.Param("poolID"))
	var req patchPoolRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid body"})
		return
	}

	pool, err := h.svc.GetPool(c.Request.Context(), poolID)
	if err != nil {
		if err == core.ErrPoolNotFound {
			c.JSON(http.StatusNotFound, gin.H{"error": "pool not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	originalBaseImage := pool.BaseImage
	originalInstanceType := pool.InstanceType
	if req.Name != nil {
		pool.Name = *req.Name
	}
	if req.Description != nil {
		pool.Description = *req.Description
	}
	if req.BaseImage != nil {
		pool.BaseImage = *req.BaseImage
	}
	if req.DesiredCapcity != nil {
		pool.DesiredCap = *req.DesiredCapcity
	}
	if req.InstanceType != nil {
		pool.InstanceType = *req.InstanceType
	}
	if req.Status != nil {
		pool.Status = *req.Status
	}
	if req.PauseReason != nil {
		pool.PauseReason = *req.PauseReason
	}
	if req.VpcID != nil {
		pool.VpcID = *req.VpcID
	}
	if req.SubnetID != nil {
		pool.SubnetID = *req.SubnetID
	}
	if req.Zone != nil {
		pool.Zone = *req.Zone
	}
	if req.SecurityGroups != nil {
		pool.SecurityGroups = *req.SecurityGroups
	}

	pool, err = h.svc.UpdatePool(c.Request.Context(), pool)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	shouldMarkCleanDry := false
	if req.MarkCleanAsDry {
		if req.BaseImage != nil && *req.BaseImage != "" && *req.BaseImage != originalBaseImage {
			shouldMarkCleanDry = true
		}
		if req.InstanceType != nil && *req.InstanceType != "" && *req.InstanceType != originalInstanceType {
			shouldMarkCleanDry = true
		}
	}
	if shouldMarkCleanDry {
		if err := h.svc.MarkCleanInstancesDry(c.Request.Context(), pool.ID); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}
	c.JSON(http.StatusOK, pool)
}
