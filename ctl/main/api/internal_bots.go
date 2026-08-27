package main

import (
	"crypto/subtle"
	"errors"
	"net/http"
	"os"
	"strings"
	"time"

	"ctl/pkg/errcode"
	modelinstance "ctl/pkg/model/instance"
	"ctl/pkg/resource"
	"ctl/pkg/transport"
	"gorm.io/gorm"
)

func requireInternalBearer(r *http.Request) bool {
	expected := firstNonEmptyEnv("LIGHTCLAW_INTERNAL_SERVICE_TOKEN", "CTL_INTERNAL_TOKEN")
	if expected == "" {
		return true
	}
	auth := strings.TrimSpace(r.Header.Get("Authorization"))
	if !strings.HasPrefix(strings.ToLower(auth), "bearer ") {
		return false
	}
	token := strings.TrimSpace(strings.TrimSpace(auth[len("Bearer "):]))
	return token == expected
}

func requireConfiguredInternalBearer(r *http.Request) bool {
	expected := strings.TrimSpace(firstNonEmptyEnv("LIGHTCLAW_INTERNAL_SERVICE_TOKEN", "CTL_INTERNAL_TOKEN"))
	if expected == "" || r == nil {
		return false
	}
	auth := strings.TrimSpace(r.Header.Get("Authorization"))
	if !strings.HasPrefix(strings.ToLower(auth), "bearer ") {
		return false
	}
	token := strings.TrimSpace(auth[len("Bearer "):])
	return len(token) == len(expected) && subtle.ConstantTimeCompare([]byte(token), []byte(expected)) == 1
}

func firstNonEmptyEnv(keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return value
		}
	}
	return ""
}

func (h *instanceHandler) handleInternalBots(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}

	page, pageSize, err := parsePagination(r)
	if err != nil {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInstanceInvalidParam, "%s", err.Error()))
		return
	}

	query := resource.GormDB.WithContext(r.Context()).Model(&modelinstance.Entity{})

	if userID := strings.TrimSpace(r.URL.Query().Get("user_id")); userID != "" {
		query = query.Where(modelinstance.ColumnUserID+" = ?", userID)
	}
	if status := strings.TrimSpace(r.URL.Query().Get("status")); status != "" {
		query = query.Where(modelinstance.ColumnStatus+" = ?", status)
	}

	var total int64
	if err := query.Count(&total).Error; err != nil {
		writeHTTPError(w, r, err)
		return
	}

	var entities []modelinstance.Entity
	if err := query.
		Order(modelinstance.ColumnCreatedAt + " DESC").
		Order(modelinstance.ColumnID + " DESC").
		Offset((page - 1) * pageSize).
		Limit(pageSize).
		Find(&entities).Error; err != nil {
		writeHTTPError(w, r, err)
		return
	}

	items := make([]*transport.BotSummaryResponse, 0, len(entities))
	for _, entity := range entities {
		var timeoutAt *time.Time
		if !entity.TimeoutAt.IsZero() {
			t := entity.TimeoutAt
			timeoutAt = &t
		}
		items = append(items, &transport.BotSummaryResponse{
			InstanceID: entity.InstanceId,
			Name:       entity.DisplayName,
			UserID:     entity.UserId,
			SandboxID:  entity.SandboxId,
			Status:     entity.Status,
			CreatedAt:  entity.CreatedAt,
			UpdatedAt:  entity.UpdatedAt,
			TimeoutAt:  timeoutAt,
		})
	}

	writeJSON(w, r, http.StatusOK, &transport.ListBotsResponse{
		Total:    total,
		Page:     page,
		PageSize: pageSize,
		Items:    items,
	})
}

func (h *instanceHandler) handleInternalBotSubresource(w http.ResponseWriter, r *http.Request) {
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/internal/bots/"), "/")
	if strings.HasSuffix(path, "/tat/session") {
		h.handleInternalBotTATSession(w, r)
		return
	}
	if path == "" || strings.Contains(path, "/") {
		writeHTTPError(w, r, errcode.ErrNotFound)
		return
	}
	h.handleInternalBot(w, r)
}

func (h *instanceHandler) handleInternalBotTATSession(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}
	if !requireConfiguredInternalBearer(r) {
		writeHTTPError(w, r, errcode.ErrUnauthorized)
		return
	}
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/internal/bots/"), "/")
	instanceID := strings.TrimSpace(strings.TrimSuffix(path, "/tat/session"))
	if instanceID == "" || strings.Contains(instanceID, "/") {
		writeHTTPError(w, r, errcode.ErrInstanceInvalidParam)
		return
	}
	ctx, ok := newRequestContext(r)
	if !ok {
		writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
		return
	}
	resp, err := h.logic.StartTerminalSession(ctx, instanceID)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, resp)
}

func (h *instanceHandler) handleInternalInstanceSubresource(w http.ResponseWriter, r *http.Request) {
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/internal/instances/"), "/")
	if path == "" {
		w.Header().Set("Allow", http.MethodGet)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}
	parts := strings.Split(path, "/")
	if len(parts) == 3 && parts[1] == "chatclaw" && parts[2] == "runtime-bootstrap" && r.Method == http.MethodGet {
		if !requireInternalBearer(r) {
			writeHTTPError(w, r, errcode.ErrUnauthorized)
			return
		}
		ctx, ok := newRequestContext(r)
		if !ok {
			writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
			return
		}
		instanceID := strings.TrimSpace(parts[0])
		conversationID := strings.TrimSpace(r.URL.Query().Get("conversation_id"))
		resp, err := h.logic.GetChatClawRuntimeBootstrap(ctx, instanceID, conversationID)
		if err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeJSON(w, r, http.StatusOK, resp)
		return
	}

	w.Header().Set("Allow", http.MethodGet)
	writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
}

func (h *instanceHandler) handleInternalBot(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		w.Header().Set("Allow", http.MethodDelete)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}

	instanceID := strings.TrimSpace(strings.Trim(strings.TrimPrefix(r.URL.Path, "/internal/bots/"), "/"))
	if instanceID == "" {
		writeHTTPError(w, r, errcode.ErrInstanceInvalidParam)
		return
	}

	var entity modelinstance.Entity
	if err := resource.GormDB.WithContext(r.Context()).
		Model(&modelinstance.Entity{}).
		Where(modelinstance.ColumnInstanceID+" = ?", instanceID).
		First(&entity).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			writeHTTPError(w, r, errcode.ErrNotFound)
			return
		}
		writeHTTPError(w, r, err)
		return
	}

	ctx, ok := requestContextFromRequest(r)
	if !ok {
		clone := r.Clone(r.Context())
		clone.Header = r.Header.Clone()
		clone.Header.Set(headerUserID, entity.UserId)
		ctx, ok = newRequestContext(clone)
		if !ok {
			writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
			return
		}
	}
	ctx = ctx.WithContext(ctx).WithUserID(entity.UserId)
	ctx.SetSqlCommentUserID(entity.UserId)
	ctx.SetLogger(buildRequestLogger(ctx, r, entity.UserId))

	resp, err := h.logic.DestroyInstance(ctx, instanceID)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, resp)
}
