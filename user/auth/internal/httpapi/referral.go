package httpapi

import (
	"context"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

var referralCodePattern = regexp.MustCompile(`^[A-Z0-9]{6,32}$`)

type referralPrepareRequest struct {
	Code string `json:"code"`
}

func (h *Handler) PrepareReferral(ctx *gin.Context) {
	if !h.referralEnabled {
		ctx.AbortWithStatus(http.StatusNotFound)
		return
	}
	var request referralPrepareRequest
	if err := ctx.ShouldBindJSON(&request); err != nil {
		ctx.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"code": "invalid_request", "message": "请求格式不正确。"})
		return
	}
	code := normalizeReferralCode(request.Code)
	if !referralCodePattern.MatchString(code) {
		ctx.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"code": "invalid_referral_code", "message": "邀请返利码格式不正确。"})
		return
	}
	if token := tokenFromContext(ctx); token != "" {
		if session, err := h.service.CurrentSession(ctx, token); err == nil {
			if err := h.service.ClaimReferral(ctx, session.User.ID, code, "authenticated_link"); err != nil {
				ctx.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"code": "referral_claim_failed", "message": "邀请关系暂时无法保存。"})
				return
			}
			h.clearReferralCookie(ctx)
			ctx.Status(http.StatusNoContent)
			return
		}
	}
	http.SetCookie(ctx.Writer, &http.Cookie{
		Name: referralCookieName, Value: code, Path: referralCookiePath,
		HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: h.cookieSecure,
		MaxAge: int((30 * time.Minute) / time.Second),
	})
	ctx.Status(http.StatusNoContent)
}

func (h *Handler) referralCodeFromContext(ctx context.Context) string {
	gctx := ginContext(ctx)
	if gctx == nil {
		return ""
	}
	return h.referralCodeFromRequest(gctx)
}

func (h *Handler) referralCodeFromRequest(ctx *gin.Context) string {
	if !h.referralEnabled {
		return ""
	}
	if value, err := ctx.Cookie(referralCookieName); err == nil {
		return normalizeReferralCode(value)
	}
	return ""
}

func (h *Handler) clearReferralCookie(ctx *gin.Context) {
	http.SetCookie(ctx.Writer, &http.Cookie{
		Name: referralCookieName, Value: "", Path: referralCookiePath,
		HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: h.cookieSecure, MaxAge: -1,
	})
}

func normalizeReferralCode(value string) string {
	return strings.ToUpper(strings.TrimSpace(value))
}
