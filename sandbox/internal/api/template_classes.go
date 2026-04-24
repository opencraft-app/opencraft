package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"cvm-mock-e2b/internal/core"
)

func (a *API) handleTemplateClasses(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		items, err := a.svc.ListTemplateClasses(r.Context())
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, items)
	case http.MethodPost:
		var req core.TemplateClass
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
			return
		}
		item, err := a.svc.UpsertTemplateClass(r.Context(), req)
		if err != nil {
			writeControlPlaneError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, item)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (a *API) handleSKUs(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		items, err := a.svc.ListSKUs(r.Context())
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, items)
	case http.MethodPost:
		var req core.SKU
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
			return
		}
		item, err := a.svc.UpsertSKU(r.Context(), req)
		if err != nil {
			writeControlPlaneError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, item)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (a *API) handleTemplateClassSubroutes(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/template-classes/")
	parts := strings.Split(path, "/")
	if len(parts) == 0 || parts[0] == "" {
		http.NotFound(w, r)
		return
	}
	templateClassID := parts[0]
	if len(parts) == 1 {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		item, err := a.svc.GetTemplateClass(r.Context(), templateClassID)
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, item)
		return
	}
	switch parts[1] {
	case "skus":
		switch r.Method {
		case http.MethodGet:
			items, err := a.svc.ListTemplateSkuBindings(r.Context(), templateClassID)
			if err != nil {
				writeControlPlaneError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, items)
		case http.MethodPut:
			var req []core.TemplateSkuBinding
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
				return
			}
			result, err := a.svc.ReplaceTemplateSkuBindings(r.Context(), templateClassID, withTemplateClassIDForSKUs(templateClassID, req))
			if err != nil {
				writeControlPlaneError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, result)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	case "bindings":
		switch r.Method {
		case http.MethodGet:
			items, err := a.svc.ListTemplatePoolBindings(r.Context(), templateClassID)
			if err != nil {
				writeError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, items)
		case http.MethodPut:
			var req []core.TemplatePoolBinding
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
				return
			}
			result, err := a.replaceTemplateClassBindings(r, templateClassID, req)
			if err != nil {
				writeControlPlaneError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, result)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	case "autoscale-policy":
		switch r.Method {
		case http.MethodGet:
			policy, err := a.svc.GetPoolAutoscalePolicy(r.Context(), templateClassID)
			if err != nil {
				writeError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, policy)
		case http.MethodPut:
			var req core.PoolAutoscalePolicy
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
				return
			}
			req.TemplateClassID = templateClassID
			policy, err := a.svc.UpsertPoolAutoscalePolicy(r.Context(), req)
			if err != nil {
				writeControlPlaneError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, policy)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	case "resolve":
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		templateClass, bindings, pools, err := a.svc.ResolveTemplateClassPools(r.Context(), templateClassID)
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"template_class": templateClass,
			"bindings":       bindings,
			"pools":          pools,
		})
	default:
		http.NotFound(w, r)
	}
}

func (a *API) replaceTemplateClassBindings(r *http.Request, templateClassID string, req []core.TemplatePoolBinding) ([]core.TemplatePoolBinding, error) {
	return a.svc.ReplaceTemplatePoolBindings(r.Context(), templateClassID, withTemplateClassID(templateClassID, req))
}

func (a *API) handleCapacityBundles(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		items, err := a.svc.ListCapacityBundles(r.Context())
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, items)
	case http.MethodPost:
		var req core.CapacityBundle
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
			return
		}
		item, err := a.svc.UpsertCapacityBundle(r.Context(), req)
		if err != nil {
			writeControlPlaneError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, item)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func writeControlPlaneError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, core.ErrTemplateClassNotFound),
		errors.Is(err, core.ErrPoolNotFound),
		errors.Is(err, core.ErrPoolAutoscalePolicyNotFound),
		errors.Is(err, core.ErrCapacityBundleNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
	}
}

func withTemplateClassID(templateClassID string, bindings []core.TemplatePoolBinding) []core.TemplatePoolBinding {
	result := make([]core.TemplatePoolBinding, 0, len(bindings))
	for _, binding := range bindings {
		binding.TemplateClassID = templateClassID
		result = append(result, binding)
	}
	return result
}

func withTemplateClassIDForSKUs(templateClassID string, bindings []core.TemplateSkuBinding) []core.TemplateSkuBinding {
	result := make([]core.TemplateSkuBinding, 0, len(bindings))
	for _, binding := range bindings {
		binding.TemplateClassID = templateClassID
		result = append(result, binding)
	}
	return result
}
