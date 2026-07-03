package main

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	tradeadapter "ctl/pkg/adapter/trade"
	"ctl/pkg/errcode"
)

type dianshiAdminHandler struct {
	tradeAdapter tradeadapter.Adapter
}

func (h *dianshiAdminHandler) handleAdminDianshi(w http.ResponseWriter, r *http.Request) {
	subPath := strings.Trim(strings.TrimPrefix(r.URL.Path, "/admin/api/ctl/dianshi"), "/")
	if subPath == "" {
		writeHTTPError(w, r, errcode.ErrNotFound)
		return
	}
	parts := strings.Split(subPath, "/")
	if len(parts) == 1 && parts[0] == "orders" {
		h.listDianshiRecords(w, r)
		return
	}
	if len(parts) == 2 && parts[0] == "orders" {
		h.deleteDianshiOrder(w, r, parts[1])
		return
	}
	if len(parts) == 2 && parts[0] == "participations" {
		h.deleteDianshiParticipation(w, r, parts[1])
		return
	}
	writeHTTPError(w, r, errcode.ErrNotFound)
}

func (h *dianshiAdminHandler) listDianshiRecords(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}
	filter, err := parseDianshiRecordFilter(r)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	if h.tradeAdapter == nil {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInternalServer, "trade adapter is not configured"))
		return
	}
	result, err := h.tradeAdapter.ListDianshiRecords(r.Context(), filter)
	if err != nil {
		writeTradeAdapterHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, result)
}

func (h *dianshiAdminHandler) deleteDianshiOrder(w http.ResponseWriter, r *http.Request, dealName string) {
	if r.Method != http.MethodDelete {
		w.Header().Set("Allow", http.MethodDelete)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}
	dealName = strings.TrimSpace(dealName)
	if dealName == "" {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "deal_name is required"))
		return
	}
	if h.tradeAdapter == nil {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInternalServer, "trade adapter is not configured"))
		return
	}
	result, err := h.tradeAdapter.DeleteDianshiOrder(r.Context(), dealName)
	if err != nil {
		writeTradeAdapterHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, result)
}

func (h *dianshiAdminHandler) deleteDianshiParticipation(w http.ResponseWriter, r *http.Request, rawID string) {
	if r.Method != http.MethodDelete {
		w.Header().Set("Allow", http.MethodDelete)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}
	id, err := strconv.ParseInt(strings.TrimSpace(rawID), 10, 64)
	if err != nil || id <= 0 {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "id must be a positive integer"))
		return
	}
	if h.tradeAdapter == nil {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInternalServer, "trade adapter is not configured"))
		return
	}
	result, err := h.tradeAdapter.DeleteDianshiParticipation(r.Context(), id)
	if err != nil {
		writeTradeAdapterHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, result)
}

func parseDianshiRecordFilter(r *http.Request) (tradeadapter.DianshiRecordFilter, error) {
	query := r.URL.Query()
	filter := tradeadapter.DianshiRecordFilter{
		ExternalUserID: strings.TrimSpace(query.Get("external_user_id")),
		Uin:            strings.TrimSpace(query.Get("uin")),
		BundleID:       strings.TrimSpace(query.Get("bundle_id")),
		DealName:       strings.TrimSpace(query.Get("deal_name")),
	}
	if raw := strings.TrimSpace(query.Get("activity_id")); raw != "" {
		activityID, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || activityID <= 0 {
			return filter, errcode.Wrap(errcode.ErrInvalidParam, "activity_id must be a positive integer")
		}
		filter.ActivityID = activityID
	}
	if raw := strings.TrimSpace(query.Get("limit")); raw != "" {
		limit, err := strconv.Atoi(raw)
		if err != nil || limit <= 0 {
			return filter, errcode.Wrap(errcode.ErrInvalidParam, "limit must be a positive integer")
		}
		filter.Limit = limit
	}
	return filter, nil
}

func writeTradeAdapterHTTPError(w http.ResponseWriter, r *http.Request, err error) {
	var tradeErr *tradeadapter.Error
	if !errors.As(err, &tradeErr) {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInternalServer, "%s", err.Error()))
		return
	}
	writeJSONWithStatus(w, r, tradeErr.Status, errorResponse{
		Code:      tradeErr.Code,
		Message:   tradeErr.Message,
		RequestID: requestIDFromRequest(r),
	})
}
