package main

import (
	"errors"
	"net/http"
	"os"
	"slices"
	"strings"
	"time"

	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	instancebirth "ctl/pkg/instancebirth"
	modelfactory "ctl/pkg/model/factory"
	modelinstance "ctl/pkg/model/instance"
	instancebirthprofile "ctl/pkg/model/instancebirthprofile"
	"ctl/pkg/resource"
	"ctl/pkg/transport"
	"gorm.io/gorm"
)

func requireInternalBearer(r *http.Request) bool {
	expected := strings.TrimSpace(os.Getenv("CTL_INTERNAL_TOKEN"))
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

	profiles, err := loadBirthProfiles(r, entities)
	if err != nil {
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
		var bornNumber *int
		var bornDate string
		if profile, ok := profiles[entity.InstanceId]; ok && profile != nil {
			bornDate = profile.BornDateForChina
			n := profile.BornNumberForChina
			bornNumber = &n
		}
		items = append(items, &transport.BotSummaryResponse{
			InstanceID:         entity.InstanceId,
			Name:               entity.DisplayName,
			UserID:             entity.UserId,
			SandboxID:          entity.SandboxId,
			Status:             entity.Status,
			CreatedAt:          entity.CreatedAt,
			UpdatedAt:          entity.UpdatedAt,
			TimeoutAt:          timeoutAt,
			BornDateForChina:   bornDate,
			BornNumberForChina: bornNumber,
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
	if strings.HasSuffix(r.URL.Path, "/borncard") {
		h.handleInternalBotBornCard(w, r)
		return
	}
	h.handleInternalBot(w, r)
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

func (h *instanceHandler) handleInternalBotBornCard(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}

	instanceID := strings.TrimSpace(strings.Trim(strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/internal/bots/"), "/borncard"), "/"))
	resp, err := h.loadBotBornCard(r, instanceID, "")
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, resp)
}

func (h *instanceHandler) loadBotBornCard(r *http.Request, instanceID string, userID string) (*transport.BotBornCardResponse, error) {
	if instanceID == "" {
		return nil, errcode.ErrInstanceInvalidParam
	}

	var entity modelinstance.Entity
	query := resource.GormDB.WithContext(r.Context()).
		Model(&modelinstance.Entity{}).
		Where(modelinstance.ColumnInstanceID+" = ?", instanceID)
	if userID != "" {
		query = query.Where(modelinstance.ColumnUserID+" = ?", userID)
	}
	if err := query.First(&entity).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, errcode.ErrNotFound
		}
		return nil, err
	}

	profiles, err := loadBirthProfiles(r, []modelinstance.Entity{entity})
	if err != nil {
		return nil, err
	}
	profile, ok := profiles[entity.InstanceId]
	if !ok || profile == nil {
		return nil, errcode.ErrNotFound
	}

	var timeoutAt *time.Time
	if !entity.TimeoutAt.IsZero() {
		t := entity.TimeoutAt
		timeoutAt = &t
	}

	return &transport.BotBornCardResponse{
		InstanceID:         entity.InstanceId,
		Name:               entity.DisplayName,
		UserID:             entity.UserId,
		SandboxID:          entity.SandboxId,
		Status:             entity.Status,
		CreatedAt:          entity.CreatedAt,
		UpdatedAt:          entity.UpdatedAt,
		TimeoutAt:          timeoutAt,
		BornDateForChina:   profile.BornDateForChina,
		BornNumberForChina: profile.BornNumberForChina,
	}, nil
}

func loadBirthProfiles(r *http.Request, entities []modelinstance.Entity) (map[string]*instancebirthprofile.Entity, error) {
	ctx := resourceContext(r)
	dao := modelfactory.DefaultDaoFactory.InstanceBirthProfileDao(ctx)
	ids := make([]string, 0, len(entities))
	for _, entity := range entities {
		ids = append(ids, entity.InstanceId)
	}

	buildMap := func(rows []instancebirthprofile.Entity) map[string]*instancebirthprofile.Entity {
		out := make(map[string]*instancebirthprofile.Entity, len(rows))
		for idx := range rows {
			row := rows[idx]
			out[row.InstanceID] = &row
		}
		return out
	}

	rows, err := dao.ListByInstanceIDs(ctx, ids)
	if err != nil {
		return nil, err
	}
	profiles := buildMap(rows)
	missingDates := make([]string, 0)
	for _, entity := range entities {
		if _, ok := profiles[entity.InstanceId]; ok {
			continue
		}
		day := instancebirth.ChinaDateString(entity.CreatedAt)
		if !slices.Contains(missingDates, day) {
			missingDates = append(missingDates, day)
		}
	}
	if len(missingDates) == 0 {
		return profiles, nil
	}

	svc := instancebirth.NewService(modelfactory.DefaultDaoFactory.InstanceDao(ctx), dao)
	for _, day := range missingDates {
		if err := svc.RebuildForChinaDate(ctx, day); err != nil {
			return nil, err
		}
	}

	rows, err = dao.ListByInstanceIDs(ctx, ids)
	if err != nil {
		return nil, err
	}
	return buildMap(rows), nil
}

func resourceContext(r *http.Request) pctx.Context {
	ctx, _ := r.Context().(pctx.Context)
	return ctx
}
