package main

import (
	"net/http"

	"ctl/pkg/errcode"
	"ctl/pkg/transport"
)

func (h *instanceHandler) configureChannel(w http.ResponseWriter, r *http.Request, instanceID string) {
	ctx, ok := newRequestContext(r)
	if !ok {
		writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
		return
	}

	var req transport.ConfigureChannelRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInstanceInvalidParam, "%s", err.Error()))
		return
	}

	resp, err := h.logic.ConfigureChannel(ctx, instanceID, &req)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}

	writeSuccess(w, r, http.StatusOK, resp)
}
