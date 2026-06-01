package httpapi

import (
	"context"
	"errors"
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
}

type invitePrepareRequest struct {
	Code string `json:"code"`
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
			State:   api.Invalid,
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
		h.clearInviteTicketCookie(gctx)
	}

	return api.SignInWithPassword200JSONResponse(h.toSessionResponse(ctx, session)), nil
}

func (h *Handler) SignUpWithPassword(ctx context.Context, request api.SignUpWithPasswordRequestObject) (api.SignUpWithPasswordResponseObject, error) {
	inviteCode := optionalStringValue(request.Body.InviteCode)
	if gctx := ginContext(ctx); gctx != nil && inviteCode == "" {
		inviteCode = h.inviteTicketFromRequest(gctx)
	}
	session, err := h.service.SignUpWithPassword(ctx, service.PasswordSignUpInput{
		Name:       request.Body.Name,
		Email:      request.Body.Email,
		Password:   request.Body.Password,
		InviteCode: inviteCode,
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

	result, err := h.service.VerifyRealname(ctx, tokenFromContext(ctx), service.RealnameVerifyInput{
		Name:   request.Body.Name,
		IDCard: request.Body.IdCard,
	})
	if err != nil {
		body, status := toErrorBody(err)
		if status >= http.StatusInternalServerError && status != http.StatusBadGateway && status != http.StatusServiceUnavailable {
			return nil, err
		}
		switch status {
		case http.StatusUnauthorized:
			return api.VerifyRealname401JSONResponse(body), nil
		case http.StatusBadGateway:
			return api.VerifyRealname502JSONResponse(body), nil
		case http.StatusServiceUnavailable:
			return api.VerifyRealname503JSONResponse(body), nil
		default:
			return api.VerifyRealname400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(body)}, nil
		}
	}

	return api.VerifyRealname200JSONResponse(api.RealnameVerifyResponse{
		Ok:           result.OK,
		Verified:     result.Verified,
		NameMasked:   result.NameMasked,
		IdCardMasked: result.IDCardMasked,
		RequestId:    result.RequestID,
	}), nil
}

type profileResponse struct {
	User api.User `json:"user"`
}

type updateProfileRequest struct {
	Name string `json:"name"`
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

	cooldown, err := h.service.SendVerificationCode(ctx, request.Body.Phone)
	if err != nil {
		body, status := toErrorBody(err)
		if status >= http.StatusInternalServerError {
			return nil, err
		}
		switch status {
		case http.StatusTooManyRequests:
			return api.SendSmsCode429JSONResponse(body), nil
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
	session, err := h.service.VerifySMS(ctx, service.VerifySMSInput{
		Name:       request.Body.Name,
		Phone:      request.Body.Phone,
		Code:       request.Body.Code,
		InviteCode: inviteCode,
	})
	if err != nil {
		body, status := toErrorBody(err)
		if status >= http.StatusInternalServerError {
			return nil, err
		}
		switch status {
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
	maxAge := int(h.sessionTTL / time.Second)
	http.SetCookie(ctx.Writer, &http.Cookie{
		Name:     sessionCookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: h.cookieSameSite,
		Secure:   h.cookieSecure,
		MaxAge:   maxAge,
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
	}
	if strings.TrimSpace(user.AvatarObjectKey) != "" {
		if avatarURL := h.publicAvatarURL(user.ID); avatarURL != "" {
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

func (h *Handler) publicAvatarURL(userID string) string {
	trimmedUserID := strings.TrimSpace(userID)
	if trimmedUserID == "" {
		return ""
	}
	return "/users/" + trimmedUserID + "/avatar"
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

func normalizeInviteCookieValue(value string) string {
	return strings.ToUpper(strings.TrimSpace(value))
}
