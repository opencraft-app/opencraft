package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"

	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	instancelogic "ctl/pkg/instance"
)

// velaIMBotLogic 是 collaboration Bot IM 开通需要的实例能力；未实现时接口返回 501。
type velaIMBotLogic interface {
	VerifyVelaIMBot(ctx pctx.Context, instanceID, botID string) (*instancelogic.VelaIMBot, error)
	DeliverVelaIMBot(ctx pctx.Context, delivery instancelogic.VelaIMDelivery) error
	RevokeVelaIMBot(ctx pctx.Context, instanceID, botID string) error
}

// velaIMPluginLogic 安装或补装实例上的 vela-im Hermes 插件。
type velaIMPluginLogic interface {
	InstallVelaIMPlugin(ctx pctx.Context, instanceID string) (string, error)
	BackfillVelaIMPlugin(ctx pctx.Context, afterID int64, limit int) (*instancelogic.VelaIMPluginBackfill, error)
}

type velaIMRequest struct {
	Action         string `json:"action"`
	AccountSubject string `json:"accountSubject"`
	InstanceID     string `json:"instanceId"`
	BotID          string `json:"botId"`
	DisplayName    string `json:"displayName"`
	BotAgentID     string `json:"botAgentId"`
	IMUserID       string `json:"imUserId"`
	OwnerIMUserID  string `json:"ownerImUserId"`
	SDKAppID       int    `json:"sdkAppId"`
	APIBaseURL     string `json:"apiBaseUrl"`
	Credential     string `json:"credential"`
	// AfterID / Limit 只用于 plugin:backfill 分批。
	AfterID int64 `json:"afterId"`
	Limit   int   `json:"limit"`
}

var velaIMSubjectPattern = regexp.MustCompile(`^usr_[A-Za-z0-9_-]{1,60}$`)

// handleInternalVelaIM 服务 collaboration 的 Bot 校验、凭据交付与吊销。
//
// 只接受配置了内部 token 的 Bearer；用户身份来自 collaboration 已验证的 LightVela 用户，
// 实例归属由 ctx 用户维度的实例查询强制校验。
func (h *instanceHandler) handleInternalVelaIM(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}
	if !requireConfiguredInternalBearer(r) {
		writeHTTPError(w, r, errcode.ErrUnauthorized)
		return
	}
	logic, ok := h.logic.(velaIMBotLogic)
	if !ok {
		writeJSON(w, r, http.StatusNotImplemented, map[string]string{"error": "vela-im bot host is not available"})
		return
	}
	action := strings.TrimPrefix(r.URL.Path, "/internal/vela-im/")
	var request velaIMRequest
	decoder := json.NewDecoder(io.LimitReader(r.Body, 16<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		writeHTTPError(w, r, errcode.ErrInstanceInvalidParam)
		return
	}
	if strings.HasPrefix(action, "plugin:") {
		h.handleVelaIMPlugin(w, r, action, request)
		return
	}
	if !velaIMSubjectPattern.MatchString(request.AccountSubject) ||
		strings.TrimSpace(request.InstanceID) == "" || strings.TrimSpace(request.BotID) == "" {
		writeHTTPError(w, r, errcode.ErrInstanceInvalidParam)
		return
	}
	ctx := pctx.NewContext(r.Context()).WithUserID(request.AccountSubject)
	switch action {
	case "bots:verify":
		bot, err := logic.VerifyVelaIMBot(ctx, request.InstanceID, request.BotID)
		if isVelaIMNotOwned(err) {
			writeJSON(w, r, http.StatusOK, map[string]any{"owned": false})
			return
		}
		if err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeJSON(w, r, http.StatusOK, map[string]any{"owned": true, "displayName": bot.Name})
	case "bots:deliver":
		err := logic.DeliverVelaIMBot(ctx, instancelogic.VelaIMDelivery{
			InstanceID: request.InstanceID, BotID: request.BotID, BotAgentID: request.BotAgentID,
			IMUserID: request.IMUserID, OwnerIMUserID: request.OwnerIMUserID, SDKAppID: request.SDKAppID, APIBaseURL: request.APIBaseURL,
			Credential: request.Credential,
		})
		if err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeJSON(w, r, http.StatusOK, map[string]any{})
	case "bots:revoke":
		if err := logic.RevokeVelaIMBot(ctx, request.InstanceID, request.BotID); err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeJSON(w, r, http.StatusOK, map[string]any{})
	default:
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
	}
}

// handleVelaIMPlugin 安装插件：plugin:install 以实例主人身份装一台；plugin:backfill 按 id 分批补装存量运行中实例。
func (h *instanceHandler) handleVelaIMPlugin(w http.ResponseWriter, r *http.Request, action string, request velaIMRequest) {
	logic, ok := h.logic.(velaIMPluginLogic)
	if !ok {
		writeJSON(w, r, http.StatusNotImplemented, map[string]string{"error": "vela-im plugin install is not available"})
		return
	}
	switch action {
	case "plugin:install":
		if !velaIMSubjectPattern.MatchString(request.AccountSubject) || strings.TrimSpace(request.InstanceID) == "" {
			writeHTTPError(w, r, errcode.ErrInstanceInvalidParam)
			return
		}
		status, err := logic.InstallVelaIMPlugin(pctx.NewContext(r.Context()).WithUserID(request.AccountSubject), request.InstanceID)
		if err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeJSON(w, r, http.StatusOK, map[string]any{"status": status})
	case "plugin:backfill":
		if request.AfterID < 0 || request.Limit < 0 {
			writeHTTPError(w, r, errcode.ErrInstanceInvalidParam)
			return
		}
		batch, err := logic.BackfillVelaIMPlugin(pctx.NewContext(r.Context()), request.AfterID, request.Limit)
		if err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeJSON(w, r, http.StatusOK, batch)
	default:
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
	}
}

func isVelaIMNotOwned(err error) bool {
	return errors.Is(err, errcode.ErrInstanceNotFound) || errors.Is(err, errcode.ErrInstanceBotNotFound)
}
