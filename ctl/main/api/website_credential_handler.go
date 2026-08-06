package main

import (
	"context"
	"crypto/subtle"
	"errors"
	"net/http"
	"os"
	"strings"

	"ctl/pkg/errcode"
	modelinstance "ctl/pkg/model/instance"
	"ctl/pkg/resource"
	"ctl/pkg/websiteauth"

	"gorm.io/gorm"
)

const websiteInstanceAuthScheme = "Vela-Instance-Key"

type websiteInstanceBinding struct {
	InstanceID string
	UserID     string
}

type websiteInstanceReader interface {
	GetWebsiteInstanceBinding(ctx context.Context, instanceID string) (*websiteInstanceBinding, error)
}

type gormWebsiteInstanceReader struct{}

func (gormWebsiteInstanceReader) GetWebsiteInstanceBinding(ctx context.Context, instanceID string) (*websiteInstanceBinding, error) {
	if resource.GormDB == nil {
		return nil, errors.New("website credential: database is not configured")
	}
	var entity modelinstance.Entity
	err := resource.GormDB.WithContext(ctx).
		Where(modelinstance.ColumnInstanceID+" = ?", instanceID).
		First(&entity).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, errcode.ErrInstanceNotFound
	}
	if err != nil {
		return nil, err
	}
	return &websiteInstanceBinding{InstanceID: entity.InstanceId, UserID: entity.UserId}, nil
}

type websiteCredentialHandler struct {
	store     websiteauth.Store
	instances websiteInstanceReader
}

type websiteCredentialResponse struct {
	Token      string `json:"token"`
	KeyID      string `json:"key_id"`
	UserID     string `json:"user_id"`
	InstanceID string `json:"instance_id"`
	CreatedAt  string `json:"created_at"`
}

func (h *websiteCredentialHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !hasValidWebsiteCredentialInternalBearer(r) {
		writeHTTPError(w, r, errcode.ErrUnauthorized)
		return
	}

	path := strings.TrimPrefix(r.URL.Path, "/internal/ctl/instances/")
	parts := strings.Split(path, "/")
	if len(parts) == 2 && parts[0] != "" && parts[1] == "website-credential" {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
			return
		}
		h.issue(w, r, parts[0])
		return
	}
	if len(parts) == 3 && parts[0] != "" && parts[1] == "website-credentials" && parts[2] != "" {
		if r.Method != http.MethodDelete {
			w.Header().Set("Allow", http.MethodDelete)
			writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
			return
		}
		h.revoke(w, r, parts[0], parts[2])
		return
	}
	writeHTTPError(w, r, errcode.ErrNotFound)
}

func (h *websiteCredentialHandler) issue(w http.ResponseWriter, r *http.Request, instanceID string) {
	if h.store == nil || h.instances == nil {
		writeHTTPError(w, r, errors.New("website credential dependencies are not configured"))
		return
	}
	instance, err := h.instances.GetWebsiteInstanceBinding(r.Context(), instanceID)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	if instance == nil || instance.InstanceID != instanceID || instance.UserID == "" {
		writeHTTPError(w, r, errcode.ErrInstanceNotFound)
		return
	}

	token, binding, err := h.store.Issue(r.Context(), instance.UserID, instance.InstanceID)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusCreated, websiteCredentialResponse{
		Token:      token,
		KeyID:      binding.KeyID,
		UserID:     binding.UserID,
		InstanceID: binding.InstanceID,
		CreatedAt:  binding.CreatedAt.UTC().Format("2006-01-02T15:04:05Z"),
	})
}

func (h *websiteCredentialHandler) revoke(w http.ResponseWriter, r *http.Request, instanceID, keyID string) {
	if h.store == nil || h.instances == nil {
		writeHTTPError(w, r, errors.New("website credential dependencies are not configured"))
		return
	}
	instance, err := h.instances.GetWebsiteInstanceBinding(r.Context(), instanceID)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	if instance == nil || instance.InstanceID != instanceID {
		writeHTTPError(w, r, errcode.ErrInstanceNotFound)
		return
	}
	if err := h.store.Revoke(r.Context(), keyID); err != nil {
		writeHTTPError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func hasValidWebsiteCredentialInternalBearer(r *http.Request) bool {
	expected := strings.TrimSpace(os.Getenv("CTL_INTERNAL_TOKEN"))
	if expected == "" || r == nil {
		return false
	}
	fields := strings.Fields(strings.TrimSpace(r.Header.Get("Authorization")))
	if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") || len(fields[1]) != len(expected) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(fields[1]), []byte(expected)) == 1
}

func websiteInstanceAuthMiddleware(store websiteauth.Store, instances websiteInstanceReader, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := strings.TrimSpace(r.Header.Get("Authorization"))
		fields := strings.Fields(auth)
		if len(fields) == 0 || !strings.EqualFold(fields[0], websiteInstanceAuthScheme) {
			next.ServeHTTP(w, r)
			return
		}

		r.Header.Del(headerUserID)
		r.Header.Del(headerUserIDAlt)
		if len(fields) != 2 || store == nil || instances == nil {
			writeHTTPError(w, r, errcode.ErrUnauthorized)
			return
		}
		binding, err := store.Validate(r.Context(), fields[1])
		if err != nil || binding == nil {
			writeHTTPError(w, r, errcode.ErrUnauthorized)
			return
		}
		instance, err := instances.GetWebsiteInstanceBinding(r.Context(), binding.InstanceID)
		if err != nil || instance == nil || instance.InstanceID != binding.InstanceID || instance.UserID != binding.UserID {
			writeHTTPError(w, r, errcode.ErrUnauthorized)
			return
		}

		r.Header.Set(headerUserID, binding.UserID)
		r.Header.Del("Authorization")
		next.ServeHTTP(w, r)
	})
}
