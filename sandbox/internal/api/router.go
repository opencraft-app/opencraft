package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"cvm-mock-e2b/internal/core"
	"cvm-mock-e2b/internal/service"
)

// API wires HTTP handlers onto the service layer.
type API struct {
	svc    *service.Service
	verify service.AddressVerifier
}

// New builds an API instance.
func New(svc *service.Service, verify service.AddressVerifier) *API {
	return &API{svc: svc, verify: verify}
}

// Routes returns the configured HTTP handler.
func (a *API) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("/pools", a.handlePools)
	mux.HandleFunc("/pools/", a.handlePoolSubroutes)
	mux.HandleFunc("/template-classes", a.handleTemplateClasses)
	mux.HandleFunc("/template-classes/", a.handleTemplateClassSubroutes)
	mux.HandleFunc("/skus", a.handleSKUs)
	mux.HandleFunc("/capacity-bundles", a.handleCapacityBundles)
	mux.HandleFunc("/instances/", a.handleInstanceSubroutes)
	return mux
}

func (a *API) handlePools(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		pools, err := a.svc.ListPools(r.Context())
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, pools)
	case http.MethodPost:
		var req struct {
			Name           string   `json:"name"`
			Description    string   `json:"description"`
			BaseImage      string   `json:"base_image"`
			InstanceType   string   `json:"instance_type"`
			VpcID          string   `json:"vpc_id"`
			SubnetID       string   `json:"subnet_id"`
			Zone           string   `json:"zone"`
			SecurityGroups []string `json:"security_groups"`
			SKUID          string   `json:"sku_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
			return
		}
		pool, err := a.svc.CreateBoundPool(r.Context(), service.CreateBoundPoolInput{
			Name:           req.Name,
			Description:    req.Description,
			BaseImage:      req.BaseImage,
			InstanceType:   req.InstanceType,
			SKUID:          req.SKUID,
			VpcID:          req.VpcID,
			SubnetID:       req.SubnetID,
			Zone:           req.Zone,
			SecurityGroups: req.SecurityGroups,
		})
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, pool)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (a *API) handlePoolSubroutes(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/pools/")
	parts := strings.Split(path, "/")
	if len(parts) == 0 || parts[0] == "" {
		http.NotFound(w, r)
		return
	}
	poolID := parts[0]
	if len(parts) == 1 {
		if r.Method != http.MethodPatch {
			http.NotFound(w, r)
			return
		}
		var req struct {
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
			SKUID          *string          `json:"sku_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
			return
		}
		pool, err := a.svc.GetPool(r.Context(), poolID)
		if err != nil {
			writeError(w, err)
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
		if req.SKUID != nil {
			pool, err = a.svc.BindPoolSKU(r.Context(), pool, *req.SKUID)
			if err != nil {
				writeError(w, err)
				return
			}
		}
		pool, err = a.svc.UpdatePool(r.Context(), pool)
		if err != nil {
			writeError(w, err)
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
			if err := a.svc.MarkCleanInstancesDry(r.Context(), pool.ID); err != nil {
				writeError(w, err)
				return
			}
		}
		writeJSON(w, http.StatusOK, pool)
		return
	}
	switch parts[1] {
	case "inventory":
		a.handleInventory(w, r, poolID)
	case "instances":
		if r.Method == http.MethodGet {
			a.handleInventory(w, r, poolID)
			return
		}
		w.WriteHeader(http.StatusMethodNotAllowed)
	case "allocate":
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		inst, err := a.svc.Allocate(r.Context(), poolID)
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, inst)
	default:
		http.NotFound(w, r)
	}
}

func (a *API) handleInventory(w http.ResponseWriter, r *http.Request, poolID string) {
	switch r.Method {
	case http.MethodGet:
		items, err := a.svc.ListInstances(r.Context(), poolID)
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, items)
	case http.MethodPost:
		var req struct {
			Count     int      `json:"count"`
			Addresses []string `json:"addresses"`
			CloudIDs  []string `json:"cloud_ids"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
			return
		}
		items, err := a.svc.RefillVerified(r.Context(), poolID, req.Count, req.Addresses, req.CloudIDs, a.verify)
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, items)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (a *API) handleInstanceSubroutes(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/instances/")
	parts := strings.Split(path, "/")
	if len(parts) == 0 || parts[0] == "" {
		http.NotFound(w, r)
		return
	}
	instanceID := parts[0]
	if len(parts) == 1 {
		http.NotFound(w, r)
		return
	}
	switch parts[1] {
	case "release":
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		inst, err := a.svc.Release(r.Context(), instanceID)
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, inst)
	case "state":
		if r.Method != http.MethodPatch {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			Target core.InstanceState `json:"target_state"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
			return
		}
		inst, err := a.svc.AdvanceState(r.Context(), instanceID, req.Target)
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, inst)
	default:
		http.NotFound(w, r)
	}
}

func writeError(w http.ResponseWriter, err error) {
	if errors.Is(err, core.ErrInvalidPoolSKUBinding) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	switch err {
	case core.ErrPoolNotFound, core.ErrInstanceNotFound, core.ErrTemplateClassNotFound, core.ErrPoolAutoscalePolicyNotFound, core.ErrCapacityBundleNotFound:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
	case core.ErrNoCleanInstance:
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	case core.ErrInvalidTransition, core.ErrInvalidRequestState:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
	default:
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
	}
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
