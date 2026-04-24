package main

import (
	"encoding/json"
	"net/http"
	"time"

	"ctl/pkg/errcode"
)

func (h *instanceHandler) createWeixinLoginSession(w http.ResponseWriter, r *http.Request, instanceID string) {
	ctx, ok := newRequestContext(r)
	if !ok {
		writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
		return
	}
	resp, err := h.logic.CreateWeixinLoginSession(ctx, instanceID)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, resp)
}

func (h *instanceHandler) getWeixinLoginSession(w http.ResponseWriter, r *http.Request, instanceID, sessionID string) {
	ctx, ok := newRequestContext(r)
	if !ok {
		writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
		return
	}
	resp, err := h.logic.GetWeixinLoginSession(ctx, instanceID, sessionID)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, resp)
}

func (h *instanceHandler) cancelWeixinLoginSession(w http.ResponseWriter, r *http.Request, instanceID, sessionID string) {
	ctx, ok := newRequestContext(r)
	if !ok {
		writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
		return
	}
	resp, err := h.logic.CancelWeixinLoginSession(ctx, instanceID, sessionID)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, resp)
}

func (h *instanceHandler) streamWeixinLoginSessionEvents(w http.ResponseWriter, r *http.Request, instanceID, sessionID string) {
	ctx, ok := newRequestContext(r)
	if !ok {
		writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
		return
	}
	snapshot, ch, cancel, err := h.logic.SubscribeWeixinLoginSession(ctx, instanceID, sessionID)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	defer cancel()

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeHTTPError(w, r, errcode.ErrInternalServer)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	writeSSE(w, "snapshot", snapshot)
	flusher.Flush()

	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-heartbeat.C:
			_, _ = w.Write([]byte(": keepalive\n\n"))
			flusher.Flush()
		case event, ok := <-ch:
			if !ok {
				return
			}
			writeSSE(w, event.Type, event)
			flusher.Flush()
			if event.Type == "finished" || event.Type == "error" {
				return
			}
		}
	}
}

func writeSSE(w http.ResponseWriter, event string, payload any) {
	body, err := json.Marshal(payload)
	if err != nil {
		return
	}
	_, _ = w.Write([]byte("event: " + event + "\n"))
	_, _ = w.Write([]byte("data: " + string(body) + "\n\n"))
}
