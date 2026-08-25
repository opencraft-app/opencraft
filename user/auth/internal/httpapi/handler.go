package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/api"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/avatar"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/service"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/tat"
)

const (
	sessionCookieName      = "lc_session"
	inviteTicketCookieName = "lc_invite_ticket"
	inviteTicketCookiePath = "/auth"
)

type Handler struct {
	service           *service.Service
	cookieSecure      bool
	cookieSameSite    http.SameSite
	sessionTTL        time.Duration
	returnToAllow     oauthReturnToAllowlist
	qqOAuth           *qqOAuth
	googleOAuth       *googleOAuth
	githubOAuth       *githubOAuth
	wechatOAuth       *wechatOAuth
	avatarStore       AvatarStore
	tatRegisterIssuer tat.RegisterCodeIssuer
	deviceBindTokens  *deviceBindTokenCodec
	publicBaseURL     string
	frontendBaseURL   string
	federation        *FederationConfig
	oidc              *OIDCConfig
}

type invitePrepareRequest struct {
	Code string `json:"code"`
}

type shadowBindingVerifyPhoneRequest struct {
	CountryCode     string `json:"country_code"`
	PhoneNumber     string `json:"phone_number"`
	PhoneVerifyCode string `json:"phone_verify_code"`
}

type shadowBindingSendSMSRequest struct {
	CountryCode string `json:"country_code"`
	PhoneNumber string `json:"phone_number"`
	Lang        string `json:"lang"`
}

type phoneChangeSendRequest struct {
	Phone string `json:"phone"`
}

type phoneChangeVerifyRequest struct {
	Phone string `json:"phone"`
	Code  string `json:"code"`
}

func NewHandler(authService *service.Service, cookieSecure bool, cookieSameSite http.SameSite, sessionTTL time.Duration, qqConfig *QQOAuthConfig, googleConfig *GoogleOAuthConfig, githubConfig *GitHubOAuthConfig, wechatConfig *WeChatOAuthConfig, publicBaseURL string, oauthReturnToAllowedHosts []string) *Handler {
	return &Handler{
		service:        authService,
		cookieSecure:   cookieSecure,
		cookieSameSite: cookieSameSite,
		sessionTTL:     sessionTTL,
		returnToAllow:  buildOAuthReturnToAllowlist(oauthReturnToAllowedHosts),
		qqOAuth:        newQQOAuth(qqConfig),
		googleOAuth:    newGoogleOAuth(googleConfig),
		githubOAuth:    newGitHubOAuth(githubConfig),
		wechatOAuth:    newWeChatOAuth(wechatConfig),
		publicBaseURL:  strings.TrimRight(strings.TrimSpace(publicBaseURL), "/"),
	}
}

func (h *Handler) validatedReturnToURL(rawURL string) string {
	if h == nil {
		return validatedReturnToURL(rawURL)
	}
	return validatedReturnToURLWithAllowlist(rawURL, h.returnToAllow)
}

func (h *Handler) ValidateInviteCode(ctx context.Context, request api.ValidateInviteCodeRequestObject) (api.ValidateInviteCodeResponseObject, error) {
	validation, err := h.service.ValidateInvite(ctx, request.Body.Code)
	if err != nil {
		return api.ValidateInviteCode200JSONResponse(api.InviteValidation{
			Code:    request.Body.Code,
			State:   api.InviteValidationStateInvalid,
			Message: err.Error(),
		}), nil
	}

	return api.ValidateInviteCode200JSONResponse(toAPIInviteValidation(validation)), nil
}

func (h *Handler) ActivateInviteCode(ctx context.Context, request api.ActivateInviteCodeRequestObject) (api.ActivateInviteCodeResponseObject, error) {
	user, err := h.service.ActivateInvite(ctx, tokenFromContext(ctx), request.Body.Code)
	if err != nil {
		body, status := toErrorBody(err)
		if status >= http.StatusInternalServerError {
			return nil, err
		}
		switch status {
		case http.StatusUnauthorized:
			return api.ActivateInviteCode401JSONResponse(body), nil
		default:
			return api.ActivateInviteCode400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(body)}, nil
		}
	}

	if gctx := ginContext(ctx); gctx != nil {
		h.clearInviteTicketCookie(gctx)
	}
	return api.ActivateInviteCode200JSONResponse(profileResponse{User: h.toAPIUser(ctx, user)}), nil
}

func (h *Handler) PrepareInvite(ctx *gin.Context) {
	h.clearInviteTicketCookie(ctx)
	ctx.Status(http.StatusNoContent)
}

func (h *Handler) ForgotPassword(ctx context.Context, request api.ForgotPasswordRequestObject) (api.ForgotPasswordResponseObject, error) {
	if err := h.service.ForgotPassword(ctx, request.Body.Email); err != nil {
		body, status := toErrorBody(err)
		if status >= http.StatusInternalServerError {
			return nil, err
		}
		return api.ForgotPassword400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(body)}, nil
	}
	return api.ForgotPassword204Response{}, nil
}

func (h *Handler) SignInWithPassword(ctx context.Context, request api.SignInWithPasswordRequestObject) (api.SignInWithPasswordResponseObject, error) {
	session, err := h.service.SignInWithPassword(ctx, request.Body.Email, request.Body.Password)
	if err != nil {
		body, status := toErrorBody(err)
		if status >= http.StatusInternalServerError {
			return nil, err
		}
		switch status {
		case http.StatusUnauthorized:
			return api.SignInWithPassword401JSONResponse(body), nil
		default:
			return api.SignInWithPassword400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(body)}, nil
		}
	}

	if gctx := ginContext(ctx); gctx != nil {
		h.setSessionCookie(gctx, session.Token)
		h.completeFederationSwitch(gctx, session.Token)
		h.clearInviteTicketCookie(gctx)
	}

	return api.SignInWithPassword200JSONResponse(h.toSessionResponse(ctx, session)), nil
}

func (h *Handler) SignUpWithPassword(ctx context.Context, request api.SignUpWithPasswordRequestObject) (api.SignUpWithPasswordResponseObject, error) {
	inviteCode := optionalStringValue(request.Body.InviteCode)
	clientIP := ""
	clientUA := ""
	if gctx := ginContext(ctx); gctx != nil {
		if inviteCode == "" {
			inviteCode = h.inviteTicketFromRequest(gctx)
		}
		clientIP = gctx.ClientIP()
		clientUA = gctx.Request.UserAgent()
	}
	session, err := h.service.SignUpWithPassword(ctx, service.PasswordSignUpInput{
		Name:       request.Body.Name,
		Email:      request.Body.Email,
		Password:   request.Body.Password,
		InviteCode: inviteCode,
		ClientIP:   clientIP,
		ClientUA:   clientUA,
	})
	if err != nil {
		body, status := toErrorBody(err)
		if status >= http.StatusInternalServerError {
			return nil, err
		}
		switch status {
		case http.StatusConflict:
			return api.SignUpWithPassword409JSONResponse(body), nil
		default:
			return api.SignUpWithPassword400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(body)}, nil
		}
	}

	if gctx := ginContext(ctx); gctx != nil {
		h.setSessionCookie(gctx, session.Token)
		h.completeFederationSwitch(gctx, session.Token)
		h.clearInviteTicketCookie(gctx)
	}

	return api.SignUpWithPassword200JSONResponse(h.toSessionResponse(ctx, session)), nil
}

func (h *Handler) SignOut(ctx context.Context, _ api.SignOutRequestObject) (api.SignOutResponseObject, error) {
	_ = h.service.SignOut(ctx, tokenFromContext(ctx))
	if gctx := ginContext(ctx); gctx != nil {
		h.clearSessionCookie(gctx)
		h.clearInviteTicketCookie(gctx)
	}
	return api.SignOut204Response{}, nil
}

func (h *Handler) GetCurrentSession(ctx context.Context, _ api.GetCurrentSessionRequestObject) (api.GetCurrentSessionResponseObject, error) {
	session, err := h.service.CurrentSession(ctx, tokenFromContext(ctx))
	if err != nil {
		body, status := toErrorBody(err)
		if status >= http.StatusInternalServerError {
			return nil, err
		}
		return api.GetCurrentSession401JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(body)}, nil
	}

	return api.GetCurrentSession200JSONResponse(h.toSessionResponse(ctx, session)), nil
}

func (h *Handler) VerifyRealname(ctx context.Context, request api.VerifyRealnameRequestObject) (api.VerifyRealnameResponseObject, error) {
	if request.Body == nil {
		return api.VerifyRealname400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(api.ErrorResponse{
			Code:    "invalid_request",
			Message: "请求格式不正确。",
		})}, nil
	}

	clientIP, clientUA := "", ""
	if gctx := ginContext(ctx); gctx != nil {
		clientIP = gctx.ClientIP()
		clientUA = gctx.Request.UserAgent()
	}
	result, err := h.service.VerifyRealname(ctx, tokenFromContext(ctx), service.RealnameVerifyInput{
		Name:     request.Body.Name,
		IDCard:   request.Body.IdCard,
		ClientIP: clientIP,
		ClientUA: clientUA,
	})
	if err != nil {
		body, status := toErrorBody(err)
		if status >= http.StatusInternalServerError && status != http.StatusBadGateway && status != http.StatusServiceUnavailable {
			return nil, err
		}
		switch status {
		case http.StatusUnauthorized:
			return api.VerifyRealname401JSONResponse(body), nil
		case http.StatusConflict:
			return api.VerifyRealname409JSONResponse(body), nil
		case http.StatusBadGateway:
			return api.VerifyRealname502JSONResponse(body), nil
		case http.StatusServiceUnavailable:
			return api.VerifyRealname503JSONResponse(body), nil
		default:
			return api.VerifyRealname400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(body)}, nil
		}
	}

	return api.VerifyRealname200JSONResponse(api.RealnameVerifyResponse{
		Ok:                        result.OK,
		Verified:                  result.Verified,
		NameMasked:                result.NameMasked,
		IdCardMasked:              result.IDCardMasked,
		RequestId:                 result.RequestID,
		PhoneVerificationRequired: result.PhoneVerificationRequired,
		PhoneVerificationSkipped:  ptrBool(result.PhoneVerificationSkipped),
		RealnameLevel:             ptrString(result.RealnameLevel),
		ShadowBindingStatus:       ptrString(result.ShadowBindingStatus),
	}), nil
}

type profileResponse struct {
	User api.User `json:"user"`
}

type updateProfileRequest struct {
	Name string `json:"name"`
}

func (h *Handler) VerifyRealnamePhone(ctx context.Context, request api.VerifyRealnamePhoneRequestObject) (api.VerifyRealnamePhoneResponseObject, error) {
	if request.Body == nil {
		return api.VerifyRealnamePhone400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(api.ErrorResponse{Code: "invalid_request", Message: "请求格式不正确。"})}, nil
	}
	clientIP, clientUA := "", ""
	if gctx := ginContext(ctx); gctx != nil {
		clientIP = gctx.ClientIP()
		clientUA = gctx.Request.UserAgent()
	}
	result, err := h.service.VerifyRealnamePhone(ctx, tokenFromContext(ctx), service.RealnamePhoneVerifyInput{Code: request.Body.Code, ClientIP: clientIP, ClientUA: clientUA})
	if err != nil {
		body, status := toErrorBody(err)
		if status >= http.StatusInternalServerError && status != http.StatusBadGateway && status != http.StatusServiceUnavailable {
			return nil, err
		}
		switch status {
		case http.StatusUnauthorized:
			return api.VerifyRealnamePhone401JSONResponse(body), nil
		case http.StatusForbidden:
			return api.VerifyRealnamePhone403JSONResponse(body), nil
		case http.StatusConflict:
			return api.VerifyRealnamePhone409JSONResponse(body), nil
		case http.StatusBadGateway:
			return api.VerifyRealnamePhone502JSONResponse(body), nil
		case http.StatusServiceUnavailable:
			return api.VerifyRealnamePhone503JSONResponse(body), nil
		default:
			return api.VerifyRealnamePhone400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(body)}, nil
		}
	}
	response := api.RealnamePhoneVerifyResponse{
		Ok:                  result.OK,
		RealnameLevel:       result.RealnameLevel,
		ShadowBindingStatus: result.ShadowBindingStatus,
	}
	if strings.TrimSpace(result.RealnameSyncStatus) != "" {
		status := api.RealnamePhoneVerifyResponseRealnameSyncStatus(result.RealnameSyncStatus)
		response.RealnameSyncStatus = &status
	}
	return api.VerifyRealnamePhone200JSONResponse(response), nil
}

func (h *Handler) StartRealnameFaceIDAttempt(ctx context.Context, request api.StartRealnameFaceIDAttemptRequestObject) (api.StartRealnameFaceIDAttemptResponseObject, error) {
	if request.Body == nil {
		return api.StartRealnameFaceIDAttempt400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(api.ErrorResponse{Code: "invalid_request", Message: "请求格式不正确。"})}, nil
	}
	clientIP, clientUA := requestClientMetadata(ctx)
	result, err := h.service.StartRealnameFaceIDAttempt(ctx, tokenFromContext(ctx), service.RealnameFaceIDStartInput{
		Name:            request.Body.Name,
		IDCard:          request.Body.IdCard,
		ConsentAccepted: request.Body.Consent,
		ClientIP:        clientIP,
		ClientUA:        clientUA,
	})
	if err != nil {
		body, status := toErrorBody(err)
		if status == http.StatusInternalServerError {
			return nil, err
		}
		switch status {
		case http.StatusUnauthorized:
			return api.StartRealnameFaceIDAttempt401JSONResponse(body), nil
		case http.StatusTooManyRequests:
			return api.StartRealnameFaceIDAttempt429JSONResponse(body), nil
		case http.StatusBadGateway:
			return api.StartRealnameFaceIDAttempt502JSONResponse(body), nil
		case http.StatusServiceUnavailable:
			return api.StartRealnameFaceIDAttempt503JSONResponse(body), nil
		default:
			return api.StartRealnameFaceIDAttempt400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(body)}, nil
		}
	}
	attempt, err := h.service.GetOwnedRealnameFaceIDAttempt(ctx, tokenFromContext(ctx), result.AttemptID, false)
	if err != nil {
		return nil, err
	}
	return api.StartRealnameFaceIDAttempt200JSONResponse(toFaceIDAttemptResponse(attempt)), nil
}

func (h *Handler) GetRealnameFaceIDAttempt(ctx context.Context, request api.GetRealnameFaceIDAttemptRequestObject) (api.GetRealnameFaceIDAttemptResponseObject, error) {
	attempt, err := h.service.GetOwnedRealnameFaceIDAttempt(ctx, tokenFromContext(ctx), request.AttemptId, true)
	if err != nil {
		body, status := toErrorBody(err)
		if status == http.StatusInternalServerError {
			return nil, err
		}
		switch status {
		case http.StatusUnauthorized:
			return api.GetRealnameFaceIDAttempt401JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(body)}, nil
		case http.StatusNotFound:
			return api.GetRealnameFaceIDAttempt404JSONResponse(body), nil
		case http.StatusBadGateway:
			return api.GetRealnameFaceIDAttempt502JSONResponse(body), nil
		default:
			return api.GetRealnameFaceIDAttempt409JSONResponse(body), nil
		}
	}
	return api.GetRealnameFaceIDAttempt200JSONResponse(toFaceIDAttemptResponse(attempt)), nil
}

func (h *Handler) GetCurrentRealnameFaceIDAttempt(ctx context.Context, _ api.GetCurrentRealnameFaceIDAttemptRequestObject) (api.GetCurrentRealnameFaceIDAttemptResponseObject, error) {
	attempt, err := h.service.GetCurrentRealnameFaceIDAttempt(ctx, tokenFromContext(ctx))
	if err != nil {
		body, status := toErrorBody(err)
		if status == http.StatusInternalServerError {
			return nil, err
		}
		switch status {
		case http.StatusUnauthorized:
			return api.GetCurrentRealnameFaceIDAttempt401JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(body)}, nil
		case http.StatusNotFound:
			return api.GetCurrentRealnameFaceIDAttempt404JSONResponse(body), nil
		case http.StatusBadGateway:
			return api.GetCurrentRealnameFaceIDAttempt502JSONResponse(body), nil
		default:
			return api.GetCurrentRealnameFaceIDAttempt409JSONResponse(body), nil
		}
	}
	return api.GetCurrentRealnameFaceIDAttempt200JSONResponse(toFaceIDAttemptResponse(attempt)), nil
}

func (h *Handler) SendRealnameFaceIDPhoneCode(ctx context.Context, request api.SendRealnameFaceIDPhoneCodeRequestObject) (api.SendRealnameFaceIDPhoneCodeResponseObject, error) {
	clientIP, _ := requestClientMetadata(ctx)
	phone := ""
	if request.Body != nil && request.Body.Phone != nil {
		phone = *request.Body.Phone
	}
	cooldown, err := h.service.SendRealnameFaceIDPhoneCode(ctx, tokenFromContext(ctx), service.RealnameFaceIDPhoneCodeInput{
		AttemptID: request.AttemptId,
		Phone:     phone,
		ClientIP:  clientIP,
	})
	if err != nil {
		body, status := toErrorBody(err)
		if status == http.StatusInternalServerError {
			return nil, err
		}
		switch status {
		case http.StatusUnauthorized:
			return api.SendRealnameFaceIDPhoneCode401JSONResponse(body), nil
		case http.StatusForbidden:
			return api.SendRealnameFaceIDPhoneCode403JSONResponse(body), nil
		case http.StatusNotFound:
			return api.SendRealnameFaceIDPhoneCode404JSONResponse(body), nil
		case http.StatusConflict:
			return api.SendRealnameFaceIDPhoneCode409JSONResponse(body), nil
		case http.StatusTooManyRequests:
			return api.SendRealnameFaceIDPhoneCode429JSONResponse(body), nil
		case http.StatusBadGateway:
			return api.SendRealnameFaceIDPhoneCode502JSONResponse(body), nil
		case http.StatusServiceUnavailable:
			return api.SendRealnameFaceIDPhoneCode503JSONResponse(body), nil
		default:
			return api.SendRealnameFaceIDPhoneCode400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(body)}, nil
		}
	}
	seconds := int(cooldown.Round(time.Second) / time.Second)
	if seconds < 0 {
		seconds = 0
	}
	return api.SendRealnameFaceIDPhoneCode200JSONResponse(api.SendSmsResponse{CooldownSeconds: seconds}), nil
}

func (h *Handler) VerifyRealnameFaceIDPhone(ctx context.Context, request api.VerifyRealnameFaceIDPhoneRequestObject) (api.VerifyRealnameFaceIDPhoneResponseObject, error) {
	if request.Body == nil {
		return api.VerifyRealnameFaceIDPhone400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(api.ErrorResponse{Code: "invalid_request", Message: "请求格式不正确。"})}, nil
	}
	clientIP, clientUA := requestClientMetadata(ctx)
	phone := ""
	if request.Body.Phone != nil {
		phone = *request.Body.Phone
	}
	attempt, err := h.service.VerifyRealnameFaceIDPhone(ctx, tokenFromContext(ctx), service.RealnameFaceIDPhoneProofInput{
		AttemptID: request.AttemptId,
		Phone:     phone,
		Code:      request.Body.Code,
		ClientIP:  clientIP,
		ClientUA:  clientUA,
	})
	if err != nil {
		body, status := toErrorBody(err)
		if status == http.StatusInternalServerError {
			return nil, err
		}
		switch status {
		case http.StatusUnauthorized:
			return api.VerifyRealnameFaceIDPhone401JSONResponse(body), nil
		case http.StatusForbidden:
			return api.VerifyRealnameFaceIDPhone403JSONResponse(body), nil
		case http.StatusNotFound:
			return api.VerifyRealnameFaceIDPhone404JSONResponse(body), nil
		case http.StatusConflict:
			return api.VerifyRealnameFaceIDPhone409JSONResponse(body), nil
		case http.StatusBadGateway:
			return api.VerifyRealnameFaceIDPhone502JSONResponse(body), nil
		case http.StatusServiceUnavailable:
			return api.VerifyRealnameFaceIDPhone503JSONResponse(body), nil
		default:
			return api.VerifyRealnameFaceIDPhone400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(body)}, nil
		}
	}
	return api.VerifyRealnameFaceIDPhone200JSONResponse(toFaceIDAttemptResponse(attempt)), nil
}

func (h *Handler) FinalizeRealnameFaceIDAttempt(ctx context.Context, request api.FinalizeRealnameFaceIDAttemptRequestObject) (api.FinalizeRealnameFaceIDAttemptResponseObject, error) {
	clientIP, clientUA := requestClientMetadata(ctx)
	_, err := h.service.FinalizeRealnameFaceIDAttempt(ctx, tokenFromContext(ctx), service.RealnameFaceIDFinalizeInput{
		AttemptID: request.AttemptId,
		ClientIP:  clientIP,
		ClientUA:  clientUA,
	})
	if err != nil {
		body, status := toErrorBody(err)
		if status == http.StatusInternalServerError {
			return nil, err
		}
		switch status {
		case http.StatusUnauthorized:
			return api.FinalizeRealnameFaceIDAttempt401JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(body)}, nil
		case http.StatusNotFound:
			return api.FinalizeRealnameFaceIDAttempt404JSONResponse(body), nil
		case http.StatusBadGateway:
			return api.FinalizeRealnameFaceIDAttempt502JSONResponse(body), nil
		case http.StatusServiceUnavailable:
			return api.FinalizeRealnameFaceIDAttempt503JSONResponse(body), nil
		default:
			return api.FinalizeRealnameFaceIDAttempt409JSONResponse(body), nil
		}
	}
	attempt, err := h.service.GetOwnedRealnameFaceIDAttempt(ctx, tokenFromContext(ctx), request.AttemptId, false)
	if err != nil {
		return nil, err
	}
	return api.FinalizeRealnameFaceIDAttempt200JSONResponse(toFaceIDAttemptResponse(attempt)), nil
}

func (h *Handler) HandleRealnameFaceIDCallback(ctx context.Context, request api.HandleRealnameFaceIDCallbackRequestObject) (api.HandleRealnameFaceIDCallbackResponseObject, error) {
	bizToken := strings.TrimSpace(request.Params.BizToken)
	if bizToken == "" {
		return api.HandleRealnameFaceIDCallback400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(api.ErrorResponse{Code: "invalid_request", Message: "请求格式不正确。"})}, nil
	}
	attempt, reconcileErr := h.service.ReconcileRealnameFaceIDAttempt(ctx, "", bizToken, "callback")
	if gctx := ginContext(ctx); gctx != nil {
		gctx.Header("Cache-Control", "no-store")
		gctx.Header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'")
		gctx.Header("Referrer-Policy", "no-referrer")
		gctx.Header("X-Content-Type-Options", "nosniff")
	}
	page := realnameFaceIDCallbackPage(attempt.State, reconcileErr)
	return api.HandleRealnameFaceIDCallback200TexthtmlResponse{Body: strings.NewReader(page), ContentLength: int64(len(page))}, nil
}

func realnameFaceIDCallbackPage(state string, reconcileErr error) string {
	title := "认证结果处理中"
	detail := "请返回 LightVela，系统将继续查询本次核身结果。"
	switch state {
	case service.RealnameFaceIDStateFaceSucceeded,
		service.RealnameFaceIDStatePhonePending,
		service.RealnameFaceIDStateShadowPending,
		service.RealnameFaceIDStateSucceeded:
		title = "人脸核身已通过"
		detail = "请返回 LightVela，继续完成手机号验证与实名同步。"
	case service.RealnameFaceIDStateFailed:
		title = "人脸核身未通过"
		detail = "请返回 LightVela 查看结果并重新认证。"
	case service.RealnameFaceIDStateExpired,
		service.RealnameFaceIDStateLateIgnored,
		service.RealnameFaceIDStateRevoked:
		title = "本次核身已失效"
		detail = "请返回 LightVela 重新发起认证。"
	default:
		if reconcileErr != nil {
			title = "认证结果查询异常"
			detail = "暂时无法确认本次核身结果，请返回 LightVela 稍后查看。"
		}
	}

	return fmt.Sprintf(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>%s</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f7f8fa;color:#202020;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:360px;padding:32px;text-align:center}h1{margin:0 0 12px;font-size:22px;line-height:1.4}p{margin:0;color:#666;font-size:15px;line-height:1.7}</style></head><body><main><h1>%s</h1><p>%s</p></main></body></html>`, title, title, detail)
}

func requestClientMetadata(ctx context.Context) (string, string) {
	if gctx := ginContext(ctx); gctx != nil {
		return gctx.ClientIP(), gctx.Request.UserAgent()
	}
	return "", ""
}

func toFaceIDAttemptResponse(attempt service.RealnameFaceIDAttempt) api.RealnameFaceIDAttemptResponse {
	state := attempt.State
	switch state {
	case service.RealnameFaceIDStateCreated, service.RealnameFaceIDStateChecking:
		state = service.RealnameFaceIDStatePending
	case service.RealnameFaceIDStateLateIgnored, service.RealnameFaceIDStateRevoked:
		state = service.RealnameFaceIDStateFailed
	}
	response := api.RealnameFaceIDAttemptResponse{
		AttemptId: attempt.AttemptID,
		State:     api.RealnameFaceIDAttemptResponseState(state),
	}
	if attempt.VerifyURL != "" {
		response.VerificationUrl = ptrString(attempt.VerifyURL)
	}
	if !attempt.BusinessExpiresAt.IsZero() {
		expiresAt := attempt.BusinessExpiresAt.UTC()
		response.ExpiresAt = &expiresAt
	}
	return response
}

func (h *Handler) SendShadowBindingSMS(ctx *gin.Context) {
	var request shadowBindingSendSMSRequest
	if err := json.NewDecoder(ctx.Request.Body).Decode(&request); err != nil {
		ctx.JSON(http.StatusBadRequest, api.ErrorResponse{Code: "invalid_request", Message: "请求格式不正确。"})
		return
	}

	clientIP, _ := requestClientMetadata(ctx)
	cooldown, err := h.service.SendShadowBindingCode(ctx, request.PhoneNumber, clientIP)
	if err != nil {
		body, status := toErrorBody(err)
		ctx.JSON(status, body)
		return
	}
	seconds := int(cooldown.Round(time.Second) / time.Second)
	if seconds < 0 {
		seconds = 0
	}
	ctx.JSON(http.StatusOK, map[string]any{"cooldown_seconds": seconds})
}

func (h *Handler) VerifyShadowBindingPhone(ctx *gin.Context) {
	var request shadowBindingVerifyPhoneRequest
	if err := json.NewDecoder(ctx.Request.Body).Decode(&request); err != nil {
		ctx.JSON(http.StatusBadRequest, api.ErrorResponse{Code: "invalid_request", Message: "请求格式不正确。"})
		return
	}

	clientIP, clientUA := requestClientMetadata(ctx)
	result, err := h.service.VerifyRealnamePhone(ctx, tokenFromContext(ctx), service.RealnamePhoneVerifyInput{
		Code:     request.PhoneVerifyCode,
		ClientIP: clientIP,
		ClientUA: clientUA,
	})
	if err != nil {
		body, status := toErrorBody(err)
		ctx.JSON(status, body)
		return
	}

	response := map[string]any{
		"ok":                    result.OK,
		"realname_level":        result.RealnameLevel,
		"shadow_binding_status": result.ShadowBindingStatus,
	}
	if binding, err := h.service.CurrentShadowBinding(ctx, tokenFromContext(ctx)); err == nil {
		response["user_id"] = binding.UserID
		response["shadow_user_name"] = binding.ShadowUserName
		response["uin"] = binding.Uin
		response["owner_uin"] = binding.OwnerUin
		response["appid"] = binding.AppID
	}
	ctx.JSON(http.StatusOK, response)
}

func (h *Handler) SendPhoneChangeSMS(ctx *gin.Context) {
	var request phoneChangeSendRequest
	if err := json.NewDecoder(ctx.Request.Body).Decode(&request); err != nil {
		ctx.JSON(http.StatusBadRequest, api.ErrorResponse{Code: "invalid_request", Message: "请求格式不正确。"})
		return
	}
	clientIP, _ := requestClientMetadata(ctx)
	cooldown, err := h.service.SendPhoneChangeCode(ctx, tokenFromContext(ctx), request.Phone, clientIP)
	if err != nil {
		body, status := toErrorBody(err)
		ctx.JSON(status, body)
		return
	}
	seconds := int(cooldown.Round(time.Second) / time.Second)
	if seconds < 0 {
		seconds = 0
	}
	ctx.JSON(http.StatusOK, api.SendSmsResponse{CooldownSeconds: seconds})
}

func (h *Handler) VerifyPhoneChange(ctx *gin.Context) {
	var request phoneChangeVerifyRequest
	if err := json.NewDecoder(ctx.Request.Body).Decode(&request); err != nil {
		ctx.JSON(http.StatusBadRequest, api.ErrorResponse{Code: "invalid_request", Message: "请求格式不正确。"})
		return
	}
	clientIP, clientUA := requestClientMetadata(ctx)
	result, err := h.service.VerifyPhoneChange(ctx, tokenFromContext(ctx), service.PhoneChangeVerifyInput{
		Phone:    request.Phone,
		Code:     request.Code,
		ClientIP: clientIP,
		ClientUA: clientUA,
	})
	if err != nil {
		body, status := toErrorBody(err)
		ctx.JSON(status, body)
		return
	}
	ctx.JSON(http.StatusOK, profileResponse{User: h.toAPIUser(ctx, result.User)})
}

func (h *Handler) GetShadowBinding(ctx context.Context, _ api.GetShadowBindingRequestObject) (api.GetShadowBindingResponseObject, error) {
	binding, err := h.service.CurrentShadowBinding(ctx, tokenFromContext(ctx))
	if err != nil {
		body, status := toErrorBody(err)
		if status >= http.StatusInternalServerError && status != http.StatusBadGateway && status != http.StatusServiceUnavailable {
			return nil, err
		}
		return api.GetShadowBinding401JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(body)}, nil
	}
	return api.GetShadowBinding200JSONResponse(api.ShadowBindingResponse{Binding: toAPIShadowBinding(binding)}), nil
}

func (h *Handler) RetryShadowBinding(ctx context.Context, _ api.RetryShadowBindingRequestObject) (api.RetryShadowBindingResponseObject, error) {
	binding, err := h.service.RetryShadowBinding(ctx, tokenFromContext(ctx))
	if err != nil {
		body, status := toErrorBody(err)
		if status >= http.StatusInternalServerError {
			return nil, err
		}
		return api.RetryShadowBinding401JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(body)}, nil
	}
	return api.RetryShadowBinding200JSONResponse(api.ShadowBindingResponse{Binding: toAPIShadowBinding(binding)}), nil
}

func (h *Handler) RetryRealnameSync(ctx context.Context, _ api.RetryRealnameSyncRequestObject) (api.RetryRealnameSyncResponseObject, error) {
	clientIP, clientUA := "", ""
	if gctx := ginContext(ctx); gctx != nil {
		clientIP = gctx.ClientIP()
		clientUA = gctx.Request.UserAgent()
	}
	result, err := h.service.RetryRealnameSync(ctx, tokenFromContext(ctx), clientIP, clientUA)
	if err != nil {
		body, status := toErrorBody(err)
		if status >= http.StatusInternalServerError && status != http.StatusBadGateway && status != http.StatusServiceUnavailable {
			return nil, err
		}
		switch status {
		case http.StatusUnauthorized:
			return api.RetryRealnameSync401JSONResponse(body), nil
		case http.StatusForbidden:
			return api.RetryRealnameSync403JSONResponse(body), nil
		case http.StatusConflict:
			return api.RetryRealnameSync409JSONResponse(body), nil
		case http.StatusBadGateway:
			return api.RetryRealnameSync502JSONResponse(body), nil
		case http.StatusServiceUnavailable:
			return api.RetryRealnameSync503JSONResponse(body), nil
		default:
			return api.RetryRealnameSync400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(body)}, nil
		}
	}
	return api.RetryRealnameSync200JSONResponse(api.RealnameSyncRetryResponse{
		Ok:                  result.OK,
		User:                h.toAPIUser(ctx, result.User),
		RealnameSyncStatus:  api.RealnameSyncRetryResponseRealnameSyncStatus(result.RealnameSyncStatus),
		ShadowBindingStatus: result.ShadowBindingStatus,
	}), nil
}

func (h *Handler) GetProfile(ctx context.Context, _ api.GetProfileRequestObject) (api.GetProfileResponseObject, error) {
	user, err := h.service.CurrentProfile(ctx, tokenFromContext(ctx))
	if err != nil {
		body, status := toErrorBody(err)
		if status >= http.StatusInternalServerError {
			return nil, err
		}
		return api.GetProfile401JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(body)}, nil
	}
	return api.GetProfile200JSONResponse(profileResponse{User: h.toAPIUser(ctx, user)}), nil
}

func (h *Handler) GetUserAvatar(ctx *gin.Context) {
	logger := requestLogger(ctx, nil)
	if h.avatarStore == nil {
		ctx.JSON(http.StatusServiceUnavailable, api.ErrorResponse{Code: "avatar_unavailable", Message: "头像服务暂不可用。"})
		return
	}

	user, err := h.service.FindUserByID(ctx, ctx.Param("userID"))
	if err != nil {
		body, status := toErrorBody(err)
		ctx.JSON(status, body)
		return
	}
	if strings.TrimSpace(user.AvatarObjectKey) == "" {
		ctx.JSON(http.StatusNotFound, api.ErrorResponse{Code: "avatar_not_found", Message: "当前用户尚未设置头像。"})
		return
	}
	signedURL, err := h.avatarStore.SignedAvatarURL(ctx.Request.Context(), user.AvatarObjectKey)
	if err != nil || strings.TrimSpace(signedURL) == "" {
		logger.Error("public avatar sign failed", "user_id", user.ID, "object_key", user.AvatarObjectKey, "err", err)
		ctx.JSON(http.StatusInternalServerError, api.ErrorResponse{Code: "avatar_unavailable", Message: "头像暂时不可访问。"})
		return
	}
	ctx.Header("Cache-Control", "no-store")
	ctx.Header("Pragma", "no-cache")
	ctx.Redirect(http.StatusFound, signedURL)
}

func (h *Handler) UpdateProfile(ctx context.Context, request api.UpdateProfileRequestObject) (api.UpdateProfileResponseObject, error) {
	if request.Body == nil {
		return api.UpdateProfile400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(api.ErrorResponse{
			Code:    "invalid_request",
			Message: "请求格式不正确。",
		})}, nil
	}

	user, err := h.service.UpdateProfile(ctx, tokenFromContext(ctx), request.Body.Name)
	if err != nil {
		body, status := toErrorBody(err)
		if status >= http.StatusInternalServerError {
			return nil, err
		}
		switch status {
		case http.StatusUnauthorized:
			return api.UpdateProfile401JSONResponse(body), nil
		default:
			return api.UpdateProfile400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(body)}, nil
		}
	}
	return api.UpdateProfile200JSONResponse(profileResponse{User: h.toAPIUser(ctx, user)}), nil
}

func (h *Handler) ContentAuditCallback(ctx *gin.Context) {
	body, err := io.ReadAll(io.LimitReader(ctx.Request.Body, 1<<20))
	if err != nil {
		requestLogger(ctx, nil).Warn("content audit callback read failed", "err", err)
		ctx.JSON(http.StatusOK, gin.H{"iRetCode": 0, "strRetMsg": "success"})
		return
	}
	if err := h.service.HandleContentAuditCallback(ctx.Request.Context(), body); err != nil {
		requestLogger(ctx, nil).Warn("content audit callback handling failed", "err", err)
	}
	ctx.JSON(http.StatusOK, gin.H{"iRetCode": 0, "strRetMsg": "success"})
}

func (h *Handler) DeleteProfile(ctx *gin.Context) {
	user, err := h.service.CurrentProfile(ctx, tokenFromContext(ctx))
	if err != nil {
		body, status := toErrorBody(err)
		ctx.JSON(status, body)
		return
	}

	if h.avatarStore != nil && strings.TrimSpace(user.AvatarObjectKey) != "" {
		if err := h.avatarStore.DeleteAvatar(ctx.Request.Context(), user.AvatarObjectKey); err != nil {
			requestLogger(ctx, nil).Error("profile avatar delete failed", "user_id", user.ID, "object_key", user.AvatarObjectKey, "err", err)
			ctx.JSON(http.StatusInternalServerError, api.ErrorResponse{Code: "avatar_delete_failed", Message: "头像删除失败。"})
			return
		}
	}

	if err := h.service.DeleteCurrentUser(ctx, tokenFromContext(ctx)); err != nil {
		body, status := toErrorBody(err)
		ctx.JSON(status, body)
		return
	}

	h.clearSessionCookie(ctx)
	h.clearInviteTicketCookie(ctx)
	ctx.Status(http.StatusNoContent)
}

func (h *Handler) UpdateProfileAvatar(ctx context.Context, request api.UpdateProfileAvatarRequestObject) (api.UpdateProfileAvatarResponseObject, error) {
	gctx := ginContext(ctx)
	logger := requestLogger(gctx, nil)
	if h.avatarStore == nil {
		return nil, &service.Error{Code: "avatar_unavailable", Message: "头像服务暂不可用。", Status: http.StatusServiceUnavailable}
	}
	if request.Body == nil {
		return api.UpdateProfileAvatar400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(api.ErrorResponse{
			Code:    "avatar_required",
			Message: "请上传头像文件。",
		})}, nil
	}

	part, err := request.Body.NextPart()
	if err != nil {
		return api.UpdateProfileAvatar400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(api.ErrorResponse{
			Code:    "avatar_required",
			Message: "请上传头像文件。",
		})}, nil
	}
	defer part.Close()
	if part.FormName() != "file" {
		return api.UpdateProfileAvatar400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(api.ErrorResponse{
			Code:    "avatar_required",
			Message: "请上传头像文件。",
		})}, nil
	}

	content, err := io.ReadAll(io.LimitReader(part, avatar.MaxBytes+1))
	if err != nil {
		return api.UpdateProfileAvatar400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(api.ErrorResponse{
			Code:    "avatar_invalid",
			Message: "头像文件读取失败。",
		})}, nil
	}
	if int64(len(content)) > avatar.MaxBytes {
		return api.UpdateProfileAvatar400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(api.ErrorResponse{
			Code:    "avatar_too_large",
			Message: "头像文件不能超过 800KB。",
		})}, nil
	}

	session, err := h.service.CurrentSession(ctx, tokenFromContext(ctx))
	if err != nil {
		body, status := toErrorBody(err)
		if status >= http.StatusInternalServerError {
			return nil, err
		}
		return api.UpdateProfileAvatar401JSONResponse(body), nil
	}
	objectKey, err := h.avatarStore.StoreAvatar(ctx, session.User.ID, content)
	if err != nil {
		logger.Error("profile avatar store failed", "user_id", session.User.ID, "err", err)
		if errors.Is(err, avatar.ErrAvatarTooLarge) {
			return api.UpdateProfileAvatar400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(api.ErrorResponse{
				Code:    "avatar_too_large",
				Message: "头像文件不能超过 800KB。",
			})}, nil
		}
		return nil, &service.Error{Code: "avatar_store_failed", Message: "头像保存失败。", Status: http.StatusInternalServerError}
	}
	var user service.User
	if h.service.AvatarAuditEnabled() {
		auditURL, signErr := h.avatarStore.SignedAvatarURL(ctx, objectKey)
		if signErr != nil || strings.TrimSpace(auditURL) == "" {
			logger.Error("profile avatar sign for audit failed", "user_id", session.User.ID, "object_key", objectKey, "err", signErr)
			return nil, &service.Error{Code: "avatar_unavailable", Message: "头像暂时不可访问。", Status: http.StatusInternalServerError}
		}
		user, err = h.service.QueueAvatarAudit(ctx, session.User.ID, objectKey, "upload", auditURL)
	} else {
		user, err = h.service.SetUserAvatar(ctx, session.User.ID, objectKey, "upload")
	}
	if err != nil {
		logger.Error("profile avatar persist failed", "user_id", session.User.ID, "object_key", objectKey, "err", err)
		body, status := toErrorBody(err)
		if status >= http.StatusInternalServerError {
			return nil, &service.Error{Code: "avatar_store_failed", Message: "头像保存失败。", Status: http.StatusInternalServerError}
		}
		return api.UpdateProfileAvatar400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(body)}, nil
	}
	return api.UpdateProfileAvatar200JSONResponse(profileResponse{User: h.toAPIUser(ctx, user)}), nil
}

func (h *Handler) GetProfileAvatar(ctx context.Context, _ api.GetProfileAvatarRequestObject) (api.GetProfileAvatarResponseObject, error) {
	gctx := ginContext(ctx)
	logger := requestLogger(gctx, nil)
	if h.avatarStore == nil {
		return nil, &service.Error{Code: "avatar_unavailable", Message: "头像服务暂不可用。", Status: http.StatusServiceUnavailable}
	}

	user, err := h.service.CurrentProfile(ctx, tokenFromContext(ctx))
	if err != nil {
		body, status := toErrorBody(err)
		if status >= http.StatusInternalServerError {
			return nil, err
		}
		return api.GetProfileAvatar401JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(body)}, nil
	}
	if strings.TrimSpace(user.AvatarObjectKey) == "" {
		return api.GetProfileAvatar404JSONResponse(api.ErrorResponse{
			Code:    "avatar_not_found",
			Message: "当前用户尚未设置头像。",
		}), nil
	}
	signedURL, err := h.avatarStore.SignedAvatarURL(ctx, user.AvatarObjectKey)
	if err != nil || strings.TrimSpace(signedURL) == "" {
		logger.Error("profile avatar sign failed", "user_id", user.ID, "object_key", user.AvatarObjectKey, "err", err)
		return nil, &service.Error{Code: "avatar_unavailable", Message: "头像暂时不可访问。", Status: http.StatusInternalServerError}
	}
	if gctx != nil {
		gctx.Header("Cache-Control", "no-store")
		gctx.Header("Pragma", "no-cache")
		gctx.Header("Location", signedURL)
	}
	return api.GetProfileAvatar302Response{}, nil
}

func (h *Handler) SendSmsCode(ctx context.Context, request api.SendSmsCodeRequestObject) (api.SendSmsCodeResponseObject, error) {
	if request.Body == nil {
		return api.SendSmsCode400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(api.ErrorResponse{
			Code:    "invalid_request",
			Message: "请求格式不正确。",
		})}, nil
	}

	clientIP, _ := requestClientMetadata(ctx)
	cooldown, err := h.service.SendVerificationCodeForClient(ctx, request.Body.Phone, clientIP)
	if err != nil {
		body, status := toErrorBody(err)
		if status >= http.StatusInternalServerError {
			return nil, err
		}
		switch status {
		case http.StatusTooManyRequests:
			return api.SendSmsCode429JSONResponse(body), nil
		case http.StatusForbidden:
			return api.SendSmsCode403JSONResponse(body), nil
		default:
			return api.SendSmsCode400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(body)}, nil
		}
	}

	seconds := int(cooldown.Round(time.Second) / time.Second)
	if seconds < 0 {
		seconds = 0
	}
	return api.SendSmsCode200JSONResponse(api.SendSmsResponse{CooldownSeconds: seconds}), nil
}

func (h *Handler) VerifySmsCode(ctx context.Context, request api.VerifySmsCodeRequestObject) (api.VerifySmsCodeResponseObject, error) {
	if request.Body == nil {
		return api.VerifySmsCode400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(api.ErrorResponse{
			Code:    "invalid_request",
			Message: "请求格式不正确。",
		})}, nil
	}

	inviteCode := optionalStringValue(request.Body.InviteCode)
	if gctx := ginContext(ctx); gctx != nil && inviteCode == "" {
		inviteCode = h.inviteTicketFromRequest(gctx)
	}
	clientIP, clientUA := requestClientMetadata(ctx)
	session, err := h.service.VerifySMS(ctx, service.VerifySMSInput{
		Name:       optionalStringValue(request.Body.Name),
		Phone:      request.Body.Phone,
		Code:       request.Body.Code,
		InviteCode: inviteCode,
		ClientIP:   clientIP,
		ClientUA:   clientUA,
	})
	if err != nil {
		body, status := toErrorBody(err)
		if status >= http.StatusInternalServerError {
			return nil, err
		}
		switch status {
		case http.StatusTooManyRequests:
			return api.VerifySmsCode429JSONResponse(body), nil
		case http.StatusUnauthorized:
			return api.VerifySmsCode401JSONResponse(body), nil
		case http.StatusForbidden:
			return api.VerifySmsCode403JSONResponse(body), nil
		default:
			return api.VerifySmsCode400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(body)}, nil
		}
	}

	if gctx := ginContext(ctx); gctx != nil {
		h.setSessionCookie(gctx, session.Token)
		h.completeFederationSwitch(gctx, session.Token)
		h.clearInviteTicketCookie(gctx)
	}
	return api.VerifySmsCode200JSONResponse(h.toSessionResponse(ctx, session)), nil
}

func ginContext(ctx context.Context) *gin.Context {
	gctx, _ := ctx.(*gin.Context)
	return gctx
}

func tokenFromContext(ctx context.Context) string {
	gctx := ginContext(ctx)
	if gctx == nil {
		return ""
	}

	authHeader := strings.TrimSpace(gctx.GetHeader("Authorization"))
	if strings.HasPrefix(strings.ToLower(authHeader), "bearer ") {
		return strings.TrimSpace(authHeader[len("Bearer "):])
	}

	if cookie, err := gctx.Cookie(sessionCookieName); err == nil {
		return strings.TrimSpace(cookie)
	}

	return ""
}

func (h *Handler) setSessionCookie(ctx *gin.Context, token string) {
	setSessionCookie(ctx, sessionCookieName, token, h.cookieSecure, h.cookieSameSite, h.sessionTTL)
}

func setSessionCookie(ctx *gin.Context, name string, token string, secure bool, sameSite http.SameSite, ttl time.Duration) {
	http.SetCookie(ctx.Writer, &http.Cookie{
		Name:     name,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: sameSite,
		Secure:   secure,
		MaxAge:   int(ttl / time.Second),
	})
}

func (h *Handler) clearSessionCookie(ctx *gin.Context) {
	http.SetCookie(ctx.Writer, &http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		SameSite: h.cookieSameSite,
		Secure:   h.cookieSecure,
		MaxAge:   -1,
	})
}

func (h *Handler) setInviteTicketCookie(ctx *gin.Context, code string) {
	http.SetCookie(ctx.Writer, &http.Cookie{
		Name:     inviteTicketCookieName,
		Value:    normalizeInviteCookieValue(code),
		Path:     inviteTicketCookiePath,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   h.cookieSecure,
		MaxAge:   int((30 * time.Minute) / time.Second),
	})
}

func (h *Handler) clearInviteTicketCookie(ctx *gin.Context) {
	http.SetCookie(ctx.Writer, &http.Cookie{
		Name:     inviteTicketCookieName,
		Value:    "",
		Path:     inviteTicketCookiePath,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   h.cookieSecure,
		MaxAge:   -1,
	})
}

func (h *Handler) inviteTicketFromRequest(ctx *gin.Context) string {
	if cookie, err := ctx.Cookie(inviteTicketCookieName); err == nil {
		return normalizeInviteCookieValue(cookie)
	}
	return ""
}

func (h *Handler) toSessionResponse(ctx context.Context, session *service.AuthSession) api.SessionResponse {
	token := session.Token
	return api.SessionResponse{
		Session: api.AuthSession{
			AuthenticatedAt: session.AuthenticatedAt,
			Impersonated:    session.Impersonated,
			SessionToken:    &token,
			User:            h.toAPIUser(ctx, session.User),
		},
	}
}

func (h *Handler) toAPIUser(ctx context.Context, user service.User) api.User {
	response := api.User{
		CreatedAt:        user.CreatedAt,
		Id:               user.ID,
		InviteRequired:   false,
		Name:             user.Name,
		RealnameVerified: user.RealnameVerified,
		EmailVerified:    user.EmailVerified,
	}
	if strings.TrimSpace(user.RealnameLevel) != "" {
		response.RealnameLevel = &user.RealnameLevel
	}
	if strings.TrimSpace(user.RealnameAssuranceMode) != "" {
		mode := api.UserRealnameAssuranceMode(user.RealnameAssuranceMode)
		response.RealnameAssuranceMode = &mode
	}
	if strings.TrimSpace(user.RealnameSyncStatus) != "" {
		status := api.UserRealnameSyncStatus(user.RealnameSyncStatus)
		response.RealnameSyncStatus = &status
	}
	if strings.TrimSpace(user.AvatarObjectKey) != "" {
		if avatarURL := h.publicAvatarURL(user.ID, user.UpdatedAt); avatarURL != "" {
			response.AvatarUrl = &avatarURL
		}
	}
	if strings.TrimSpace(user.PendingAvatarObjectKey) != "" && h.avatarStore != nil {
		if pendingAvatarURL, err := h.avatarStore.SignedAvatarURL(ctx, user.PendingAvatarObjectKey); err == nil && strings.TrimSpace(pendingAvatarURL) != "" {
			response.PendingAvatarUrl = &pendingAvatarURL
		}
	}
	if strings.TrimSpace(user.AvatarAuditStatus) != "" {
		status := api.UserAvatarAuditStatus(user.AvatarAuditStatus)
		response.AvatarAuditStatus = &status
	}
	if user.Email != "" {
		response.Email = &user.Email
	}
	if strings.TrimSpace(user.PendingName) != "" {
		response.PendingName = &user.PendingName
	}
	if strings.TrimSpace(user.NameAuditStatus) != "" {
		status := api.UserNameAuditStatus(user.NameAuditStatus)
		response.NameAuditStatus = &status
	}
	if user.Phone != "" {
		response.Phone = &user.Phone
	}
	return response
}

func (h *Handler) publicAvatarURL(userID string, updatedAt time.Time) string {
	trimmedUserID := strings.TrimSpace(userID)
	if trimmedUserID == "" {
		return ""
	}
	url := "/users/" + trimmedUserID + "/avatar"
	if !updatedAt.IsZero() {
		return url + "?v=" + updatedAt.UTC().Format("20060102150405.000000000")
	}
	return url
}

func toAPIShadowBinding(binding service.ShadowBindingResult) api.ShadowBinding {
	out := api.ShadowBinding{Status: binding.Status}
	if binding.UserID != "" {
		out.UserId = &binding.UserID
	}
	if binding.ShadowUserName != "" {
		out.ShadowUserName = &binding.ShadowUserName
	}
	if binding.Uin != 0 {
		out.Uin = &binding.Uin
	}
	if binding.OwnerUin != 0 {
		out.OwnerUin = &binding.OwnerUin
	}
	if binding.AppID != 0 {
		out.AppId = &binding.AppID
	}
	if binding.LastErrorCode != "" {
		out.LastErrorCode = &binding.LastErrorCode
	}
	if binding.LastErrorMessage != "" {
		out.LastErrorMessage = &binding.LastErrorMessage
	}
	if binding.BasicAuthStatus != "" {
		status := api.ShadowBindingBasicAuthStatus(binding.BasicAuthStatus)
		out.BasicAuthStatus = &status
	}
	if binding.BasicAuthSyncedAt != nil {
		out.BasicAuthSyncedAt = binding.BasicAuthSyncedAt
	}
	if binding.BasicAuthLastErrorCode != "" {
		out.BasicAuthLastErrorCode = &binding.BasicAuthLastErrorCode
	}
	if binding.BasicAuthLastErrorMessage != "" {
		out.BasicAuthLastErrorMessage = &binding.BasicAuthLastErrorMessage
	}
	if !binding.CreatedAt.IsZero() {
		out.CreatedAt = &binding.CreatedAt
	}
	if !binding.UpdatedAt.IsZero() {
		out.UpdatedAt = &binding.UpdatedAt
	}
	return out
}

func toAPIInviteValidation(validation service.InviteValidation) api.InviteValidation {
	return api.InviteValidation{
		Code:    validation.Code,
		State:   api.InviteValidationState(validation.State),
		Message: validation.Message,
	}
}

func toErrorBody(err error) (api.ErrorResponse, int) {
	authErr, ok := err.(*service.Error)
	if !ok {
		if errors.Is(err, http.ErrMissingFile) {
			return api.ErrorResponse{Code: "avatar_required", Message: "请上传头像文件。"}, http.StatusBadRequest
		}
		return api.ErrorResponse{Code: "internal_error", Message: "服务暂时不可用，请稍后重试。"}, http.StatusInternalServerError
	}

	body := api.ErrorResponse{
		Code:    authErr.Code,
		Message: authErr.Message,
	}
	if authErr.RetryAfter > 0 {
		seconds := int(authErr.RetryAfter.Round(time.Second) / time.Second)
		if seconds < 1 {
			seconds = 1
		}
		body.RetryAfterSeconds = &seconds
	}
	return body, authErr.Status
}

func optionalStringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func ptrBool(value bool) *bool {
	if !value {
		return nil
	}
	return &value
}

func ptrString(value string) *string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func normalizeInviteCookieValue(value string) string {
	return strings.ToUpper(strings.TrimSpace(value))
}
