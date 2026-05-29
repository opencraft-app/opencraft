package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/avatar"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/service"
)

const testAdminToken = "test-admin-secret"

func TestSetSessionCookieUsesConfiguredCrossSiteAttributes(t *testing.T) {
	t.Parallel()

	gin.SetMode(gin.TestMode)

	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	handler := NewHandler(nil, true, http.SameSiteNoneMode, 30*24*time.Hour, nil, nil, nil, nil, "https://lightclaw.tech", nil)

	handler.setSessionCookie(ctx, "token-123")

	resp := recorder.Result()
	t.Cleanup(func() { _ = resp.Body.Close() })

	cookies := resp.Cookies()
	if len(cookies) != 1 {
		t.Fatalf("expected 1 cookie, got %d", len(cookies))
	}

	cookie := cookies[0]
	if !cookie.Secure {
		t.Fatal("expected cookie to be secure")
	}
	if !cookie.HttpOnly {
		t.Fatal("expected cookie to be httpOnly")
	}
	if cookie.SameSite != http.SameSiteNoneMode {
		t.Fatalf("expected SameSite=None, got %v", cookie.SameSite)
	}
	if cookie.Name != sessionCookieName {
		t.Fatalf("expected cookie name %q, got %q", sessionCookieName, cookie.Name)
	}
}

func TestPasswordSignUpDoesNotExposePlanSelectionBeforeConfirmation(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouter()
	recorder := performJSONRequest(t, router, http.MethodPost, "/auth/password/sign-up", map[string]any{
		"name":       "Alice",
		"email":      "alice@example.com",
		"password":   "password123",
		"inviteCode": "VALID2026",
	})

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body.String())
	}

	var response sessionResponseBody
	decodeJSONResponse(t, recorder, &response)
	if response.Session.PlanSelection != nil {
		t.Fatal("expected planSelection to be nil before confirmation")
	}
}

func TestPasswordSignInDoesNotExposePlanSelection(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouter()

	signUp := performJSONRequest(t, router, http.MethodPost, "/auth/password/sign-up", map[string]any{
		"name":       "Alice",
		"email":      "alice@example.com",
		"password":   "password123",
		"inviteCode": "VALID2026",
	})
	signUpCookie := sessionCookieFromRecorder(t, signUp)

	signOut := performJSONRequest(t, router, http.MethodDelete, "/auth/session", nil, signUpCookie)
	if signOut.Code != http.StatusNoContent {
		t.Fatalf("expected 204 from sign out, got %d: %s", signOut.Code, signOut.Body.String())
	}

	signIn := performJSONRequest(t, router, http.MethodPost, "/auth/password/sign-in", map[string]any{
		"email":    "alice@example.com",
		"password": "password123",
	})
	if signIn.Code != http.StatusOK {
		t.Fatalf("expected 200 from sign in, got %d: %s", signIn.Code, signIn.Body.String())
	}

	var response sessionResponseBody
	decodeJSONResponse(t, signIn, &response)
	if response.Session.PlanSelection != nil {
		t.Fatal("expected planSelection to be omitted from session response")
	}
}

func TestGetCurrentSessionDoesNotExposePlanSelection(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouter()

	signUp := performJSONRequest(t, router, http.MethodPost, "/auth/password/sign-up", map[string]any{
		"name":       "Bob",
		"email":      "bob@example.com",
		"password":   "password123",
		"inviteCode": "VALID2026",
	})
	signUpCookie := sessionCookieFromRecorder(t, signUp)

	_ = performJSONRequest(t, router, http.MethodDelete, "/auth/session", nil, signUpCookie)

	signIn := performJSONRequest(t, router, http.MethodPost, "/auth/password/sign-in", map[string]any{
		"email":    "bob@example.com",
		"password": "password123",
	})
	sessionCookie := sessionCookieFromRecorder(t, signIn)

	current := performJSONRequest(t, router, http.MethodGet, "/auth/session", nil, sessionCookie)
	if current.Code != http.StatusOK {
		t.Fatalf("expected 200 from current session, got %d: %s", current.Code, current.Body.String())
	}

	var response sessionResponseBody
	decodeJSONResponse(t, current, &response)
	if response.Session.PlanSelection != nil {
		t.Fatal("expected planSelection to be omitted from current session")
	}
}

func TestVerifyRealnameRequiresAuth(t *testing.T) {
	router := newAuthTestRouterWithRealname()

	recorder := performJSONRequest(t, router, http.MethodPost, "/auth/realname/verify", map[string]any{
		"name":   "张三",
		"idCard": "11010519491231002X",
	})

	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 from unauthenticated realname verify, got %d: %s", recorder.Code, recorder.Body.String())
	}
}

func TestVerifyRealnameSuccessUpdatesSessionBooleanOnly(t *testing.T) {
	router := newAuthTestRouterWithRealname()
	signUp := performJSONRequest(t, router, http.MethodPost, "/auth/password/sign-up", map[string]any{
		"name":     "Realname User",
		"email":    "realname-http@example.com",
		"password": "password123",
	})
	sessionCookie := findSetCookie(t, signUp, sessionCookieName)

	recorder := performJSONRequest(t, router, http.MethodPost, "/auth/realname/verify", map[string]any{
		"name":   "张三",
		"idCard": "11010519491231002X",
	}, sessionCookie)
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200 from realname verify, got %d: %s", recorder.Code, recorder.Body.String())
	}

	var verifyBody struct {
		OK           bool   `json:"ok"`
		Verified     bool   `json:"verified"`
		NameMasked   string `json:"nameMasked"`
		IDCardMasked string `json:"idCardMasked"`
		RequestID    string `json:"requestId"`
	}
	decodeJSONResponse(t, recorder, &verifyBody)
	if !verifyBody.OK || !verifyBody.Verified || verifyBody.NameMasked != "张*" || verifyBody.IDCardMasked != "1101**********002X" || verifyBody.RequestID != "req-http" {
		t.Fatalf("unexpected verify body: %+v", verifyBody)
	}

	current := performJSONRequest(t, router, http.MethodGet, "/auth/session", nil, sessionCookie)
	if current.Code != http.StatusOK {
		t.Fatalf("expected 200 from session, got %d: %s", current.Code, current.Body.String())
	}
	var sessionBody sessionResponseBody
	decodeJSONResponse(t, current, &sessionBody)
	if sessionBody.Session.User == nil || !sessionBody.Session.User.RealnameVerified {
		t.Fatalf("expected session realnameVerified=true, got %+v", sessionBody.Session.User)
	}
	if strings.Contains(current.Body.String(), "nameMasked") || strings.Contains(current.Body.String(), "idCardMasked") || strings.Contains(current.Body.String(), "verifiedAt") {
		t.Fatalf("session leaked realname metadata: %s", current.Body.String())
	}
}

func TestGetCurrentSessionReturnsSignedAvatarURL(t *testing.T) {
	t.Parallel()

	avatarStore := &stubAvatarStore{
		objectKey: "avatars/usr_01/current.jpg",
		signedURL: "https://lightclawuser-1388575217.cos.ap-beijing.myqcloud.com/avatars/usr_01/current.jpg?sign=demo",
	}
	router := newAuthTestRouterWithAvatarStore(avatarStore)

	signUp := performJSONRequest(t, router, http.MethodPost, "/auth/password/sign-up", map[string]any{
		"name":       "头像用户",
		"email":      "session-avatar@example.com",
		"password":   "password123",
		"inviteCode": "VALID2026",
	})
	sessionCookie := sessionCookieFromRecorder(t, signUp)

	upload := performMultipartAvatarUploadRequest(t, router, "/auth/profile/avatar", sessionCookie, testPNGBytes(t))
	if upload.Code != http.StatusOK {
		t.Fatalf("expected upload success, got %d: %s", upload.Code, upload.Body.String())
	}

	var signUpBody sessionResponseBody
	decodeJSONResponse(t, signUp, &signUpBody)

	current := performJSONRequest(t, router, http.MethodGet, "/auth/session", nil, sessionCookie)
	if current.Code != http.StatusOK {
		t.Fatalf("expected 200 from current session, got %d: %s", current.Code, current.Body.String())
	}

	var response sessionResponseBody
	decodeJSONResponse(t, current, &response)
	wantAvatarURL := "/users/" + signUpBody.Session.User.ID + "/avatar"
	if response.Session.User == nil || response.Session.User.AvatarURL != wantAvatarURL {
		t.Fatalf("expected fixed avatar path on current session, got %+v", response.Session.User)
	}
}

func TestDeleteProfileRemovesCurrentUserAndClearsSessionCookie(t *testing.T) {
	t.Parallel()

	avatarStore := &stubAvatarStore{
		objectKey: "avatars/usr_01/current.jpg",
	}
	router := newAuthTestRouterWithAvatarStore(avatarStore)

	signUp := performJSONRequest(t, router, http.MethodPost, "/auth/password/sign-up", map[string]any{
		"name":       "Delete User",
		"email":      "delete-user@example.com",
		"password":   "password123",
		"inviteCode": "VALID2026",
	})
	sessionCookie := sessionCookieFromRecorder(t, signUp)

	upload := performMultipartAvatarUploadRequest(t, router, "/auth/profile/avatar", sessionCookie, testPNGBytes(t))
	if upload.Code != http.StatusOK {
		t.Fatalf("expected upload success, got %d: %s", upload.Code, upload.Body.String())
	}

	deleted := performJSONRequest(t, router, http.MethodDelete, "/auth/profile", nil, sessionCookie)
	if deleted.Code != http.StatusNoContent {
		t.Fatalf("expected 204 from delete profile, got %d: %s", deleted.Code, deleted.Body.String())
	}
	if avatarStore.lastDeletedObjectKey != "avatars/usr_01/current.jpg" {
		t.Fatalf("expected avatar object to be deleted, got %q", avatarStore.lastDeletedObjectKey)
	}

	resp := deleted.Result()
	t.Cleanup(func() { _ = resp.Body.Close() })
	var cleared bool
	for _, cookie := range resp.Cookies() {
		if cookie.Name == sessionCookieName {
			cleared = true
			if cookie.MaxAge != -1 {
				t.Fatalf("expected cleared session cookie MaxAge -1, got %d", cookie.MaxAge)
			}
		}
	}
	if !cleared {
		t.Fatal("expected delete profile to clear session cookie")
	}

	current := performJSONRequest(t, router, http.MethodGet, "/auth/session", nil, sessionCookie)
	if current.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 from current session after account deletion, got %d: %s", current.Code, current.Body.String())
	}
}

func TestActivateInviteClearsInviteRequiredForCurrentUser(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouterWithQQ(&stubQQOAuthClient{
		identity: service.OAuthSignInInput{
			Provider:        "qq",
			ProviderSubject: "openid-qq-activate",
			Name:            "QQ待激活用户",
		},
	})

	start := performJSONRequest(t, router, http.MethodGet, "/auth/oauth/qq/start", nil)
	startLocation, err := url.Parse(start.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse start location: %v", err)
	}
	state := startLocation.Query().Get("state")
	stateCookie := cookieFromRecorderByName(t, start, "lc_qq_oauth_state")

	callback := performJSONRequest(
		t,
		router,
		http.MethodGet,
		"/auth/oauth/qq/callback?code=qq-code-activate&state="+url.QueryEscape(state),
		nil,
		stateCookie,
	)
	if callback.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from qq oauth callback, got %d: %s", callback.Code, callback.Body.String())
	}
	sessionCookie := sessionCookieFromRecorder(t, callback)

	activated := performJSONRequest(t, router, http.MethodPost, "/auth/invite/activate", map[string]any{
		"code": "VALID2026",
	}, sessionCookie)
	if activated.Code != http.StatusOK {
		t.Fatalf("expected 200 from invite activate, got %d: %s", activated.Code, activated.Body.String())
	}

	var activatedBody profileResponseBody
	decodeJSONResponse(t, activated, &activatedBody)
	if activatedBody.User == nil || activatedBody.User.InviteRequired {
		t.Fatalf("expected activated user to clear inviteRequired, got %+v", activatedBody.User)
	}

	current := performJSONRequest(t, router, http.MethodGet, "/auth/session", nil, sessionCookie)
	if current.Code != http.StatusOK {
		t.Fatalf("expected 200 from current session, got %d: %s", current.Code, current.Body.String())
	}

	var currentBody sessionResponseBody
	decodeJSONResponse(t, current, &currentBody)
	if currentBody.Session.User == nil || currentBody.Session.User.InviteRequired {
		t.Fatalf("expected session user to be activated, got %+v", currentBody.Session.User)
	}
}

func TestAdminDeleteUserRemovesTargetUser(t *testing.T) {
	t.Parallel()

	avatarStore := &stubAvatarStore{
		objectKey: "avatars/usr_01/current.jpg",
	}
	router := newAuthTestRouterWithOptions(avatarStore, testAdminToken)

	signUp := performJSONRequest(t, router, http.MethodPost, "/auth/password/sign-up", map[string]any{
		"name":       "Delete By Admin",
		"email":      "delete-admin@example.com",
		"password":   "password123",
		"inviteCode": "VALID2026",
	})
	sessionCookie := sessionCookieFromRecorder(t, signUp)

	upload := performMultipartAvatarUploadRequest(t, router, "/auth/profile/avatar", sessionCookie, testPNGBytes(t))
	if upload.Code != http.StatusOK {
		t.Fatalf("expected upload success, got %d: %s", upload.Code, upload.Body.String())
	}

	var body sessionResponseBody
	decodeJSONResponse(t, signUp, &body)
	if body.Session.User == nil {
		t.Fatal("expected session user")
	}

	deleted := performAdminJSONRequest(t, router, http.MethodDelete, "/admin/users/"+body.Session.User.ID, nil, testAdminToken)
	if deleted.Code != http.StatusNoContent {
		t.Fatalf("expected 204 from admin delete user, got %d: %s", deleted.Code, deleted.Body.String())
	}
	if avatarStore.lastDeletedObjectKey != "avatars/usr_01/current.jpg" {
		t.Fatalf("expected avatar object to be deleted, got %q", avatarStore.lastDeletedObjectKey)
	}

	current := performJSONRequest(t, router, http.MethodGet, "/auth/session", nil, sessionCookie)
	if current.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 from current session after admin delete, got %d: %s", current.Code, current.Body.String())
	}
}

func TestGetProfileReturnsCurrentUser(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouter()

	signUp := performJSONRequest(t, router, http.MethodPost, "/auth/password/sign-up", map[string]any{
		"name":       "Eve",
		"email":      "eve@example.com",
		"password":   "password123",
		"inviteCode": "VALID2026",
	})
	sessionCookie := sessionCookieFromRecorder(t, signUp)

	current := performJSONRequest(t, router, http.MethodGet, "/auth/profile", nil, sessionCookie)
	if current.Code != http.StatusOK {
		t.Fatalf("expected 200 from get profile, got %d: %s", current.Code, current.Body.String())
	}

	var response profileResponseBody
	decodeJSONResponse(t, current, &response)
	if response.User == nil || response.User.Name != "Eve" {
		t.Fatalf("expected profile response to include current user, got %+v", response.User)
	}
	if response.User.AvatarURL != "" {
		t.Fatalf("expected no avatar url by default, got %q", response.User.AvatarURL)
	}
}

func TestPutProfileUpdatesName(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouter()

	signUp := performJSONRequest(t, router, http.MethodPost, "/auth/password/sign-up", map[string]any{
		"name":       "旧昵称",
		"email":      "profile@example.com",
		"password":   "password123",
		"inviteCode": "VALID2026",
	})
	sessionCookie := sessionCookieFromRecorder(t, signUp)

	update := performJSONRequest(t, router, http.MethodPut, "/auth/profile", map[string]any{
		"name": "新昵称",
	}, sessionCookie)
	if update.Code != http.StatusOK {
		t.Fatalf("expected 200 from put profile, got %d: %s", update.Code, update.Body.String())
	}

	var response profileResponseBody
	decodeJSONResponse(t, update, &response)
	if response.User == nil || response.User.Name != "新昵称" {
		t.Fatalf("expected updated nickname, got %+v", response.User)
	}
}

func TestPutProfileAvatarStoresObjectAndReturnsAvatarURL(t *testing.T) {
	t.Parallel()

	avatarStore := &stubAvatarStore{
		objectKey: "avatars/usr_01/current.jpg",
		signedURL: "https://lightclawuser-1388575217.cos.ap-beijing.myqcloud.com/avatars/usr_01/current.jpg?sign=demo",
	}
	router := newAuthTestRouterWithAvatarStore(avatarStore)

	signUp := performJSONRequest(t, router, http.MethodPost, "/auth/password/sign-up", map[string]any{
		"name":       "头像用户",
		"email":      "avatar@example.com",
		"password":   "password123",
		"inviteCode": "VALID2026",
	})
	sessionCookie := sessionCookieFromRecorder(t, signUp)

	recorder := performMultipartAvatarUploadRequest(t, router, "/auth/profile/avatar", sessionCookie, testPNGBytes(t))
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200 from avatar upload, got %d: %s", recorder.Code, recorder.Body.String())
	}

	if avatarStore.lastUploadedUserID == "" {
		t.Fatal("expected avatar store to receive upload")
	}

	var response profileResponseBody
	decodeJSONResponse(t, recorder, &response)
	wantAvatarURL := "/users/" + avatarStore.lastUploadedUserID + "/avatar"
	if response.User == nil || response.User.AvatarURL != wantAvatarURL {
		t.Fatalf("expected uploaded avatar url, got %+v", response.User)
	}
}

func TestGetProfileAvatarRedirectsToSignedURL(t *testing.T) {
	t.Parallel()

	avatarStore := &stubAvatarStore{
		objectKey: "avatars/usr_01/current.jpg",
		signedURL: "https://lightclawuser-1388575217.cos.ap-beijing.myqcloud.com/avatars/usr_01/current.jpg?sign=demo",
	}
	router := newAuthTestRouterWithAvatarStore(avatarStore)

	signUp := performJSONRequest(t, router, http.MethodPost, "/auth/password/sign-up", map[string]any{
		"name":       "头像用户",
		"email":      "avatar-redirect@example.com",
		"password":   "password123",
		"inviteCode": "VALID2026",
	})
	sessionCookie := sessionCookieFromRecorder(t, signUp)

	upload := performMultipartAvatarUploadRequest(t, router, "/auth/profile/avatar", sessionCookie, testPNGBytes(t))
	if upload.Code != http.StatusOK {
		t.Fatalf("expected upload success, got %d: %s", upload.Code, upload.Body.String())
	}

	redirect := performJSONRequest(t, router, http.MethodGet, "/auth/profile/avatar", nil, sessionCookie)
	if redirect.Code != http.StatusFound {
		t.Fatalf("expected 302 from profile avatar, got %d: %s", redirect.Code, redirect.Body.String())
	}
	if location := redirect.Header().Get("Location"); location != avatarStore.signedURL {
		t.Fatalf("expected redirect to signed url %q, got %q", avatarStore.signedURL, location)
	}
}

func TestGetUserAvatarRedirectsToSignedURL(t *testing.T) {
	t.Parallel()

	avatarStore := &stubAvatarStore{
		objectKey: "avatars/usr_01/current.jpg",
		signedURL: "https://lightclawuser-1388575217.cos.ap-beijing.myqcloud.com/avatars/usr_01/current.jpg?sign=demo",
	}
	router := newAuthTestRouterWithAvatarStore(avatarStore)

	signUp := performJSONRequest(t, router, http.MethodPost, "/auth/password/sign-up", map[string]any{
		"name":       "头像用户",
		"email":      "avatar-public@example.com",
		"password":   "password123",
		"inviteCode": "VALID2026",
	})
	sessionCookie := sessionCookieFromRecorder(t, signUp)

	upload := performMultipartAvatarUploadRequest(t, router, "/auth/profile/avatar", sessionCookie, testPNGBytes(t))
	if upload.Code != http.StatusOK {
		t.Fatalf("expected upload success, got %d: %s", upload.Code, upload.Body.String())
	}

	var signUpBody sessionResponseBody
	decodeJSONResponse(t, signUp, &signUpBody)

	redirect := performJSONRequest(t, router, http.MethodGet, "/users/"+signUpBody.Session.User.ID+"/avatar", nil)
	if redirect.Code != http.StatusFound {
		t.Fatalf("expected 302 from public user avatar, got %d: %s", redirect.Code, redirect.Body.String())
	}
	if location := redirect.Header().Get("Location"); location != avatarStore.signedURL {
		t.Fatalf("expected redirect to signed url %q, got %q", avatarStore.signedURL, location)
	}
}

func TestPutProfileAvatarRejectsPayloadLargerThanLimit(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouterWithAvatarStore(&stubAvatarStore{})

	signUp := performJSONRequest(t, router, http.MethodPost, "/auth/password/sign-up", map[string]any{
		"name":       "头像用户",
		"email":      "avatar-limit@example.com",
		"password":   "password123",
		"inviteCode": "VALID2026",
	})
	sessionCookie := sessionCookieFromRecorder(t, signUp)

	oversized := bytes.Repeat([]byte("a"), int(avatar.MaxBytes)+1)
	recorder := performMultipartAvatarUploadRequest(t, router, "/auth/profile/avatar", sessionCookie, oversized)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 from oversized avatar upload, got %d: %s", recorder.Code, recorder.Body.String())
	}

	var response errorResponseBody
	decodeJSONResponse(t, recorder, &response)
	if response.Code != "avatar_too_large" {
		t.Fatalf("expected avatar_too_large, got %q", response.Code)
	}
}

func TestPutProfileAvatarReturnsTooLargeWhenNormalizedAvatarExceedsLimit(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouterWithAvatarStore(&stubAvatarStore{
		storeErr: avatar.ErrAvatarTooLarge,
	})

	signUp := performJSONRequest(t, router, http.MethodPost, "/auth/password/sign-up", map[string]any{
		"name":       "头像用户",
		"email":      "avatar-normalized-limit@example.com",
		"password":   "password123",
		"inviteCode": "VALID2026",
	})
	sessionCookie := sessionCookieFromRecorder(t, signUp)

	recorder := performMultipartAvatarUploadRequest(t, router, "/auth/profile/avatar", sessionCookie, testPNGBytes(t))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 from normalized oversized avatar upload, got %d: %s", recorder.Code, recorder.Body.String())
	}

	var response errorResponseBody
	decodeJSONResponse(t, recorder, &response)
	if response.Code != "avatar_too_large" {
		t.Fatalf("expected avatar_too_large, got %q", response.Code)
	}
}

func TestSendSmsCodeReturnsCooldownWhenPhoneAuthIsEnabled(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouter()
	recorder := performJSONRequest(t, router, http.MethodPost, "/auth/sms/send", map[string]any{
		"phone": "13800138000",
	})

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body.String())
	}

	var response struct {
		CooldownSeconds int `json:"cooldownSeconds"`
	}
	decodeJSONResponse(t, recorder, &response)
	if response.CooldownSeconds <= 0 {
		t.Fatalf("expected positive cooldown seconds, got %d", response.CooldownSeconds)
	}
}

func TestVerifySmsCodeCreatesSessionWhenCodeMatches(t *testing.T) {
	t.Parallel()

	router := newAuthTestRouter()

	sendCode := performJSONRequest(t, router, http.MethodPost, "/auth/sms/send", map[string]any{
		"phone": "13800138000",
	})
	if sendCode.Code != http.StatusOK {
		t.Fatalf("expected 200 from send sms, got %d: %s", sendCode.Code, sendCode.Body.String())
	}

	recorder := performJSONRequest(t, router, http.MethodPost, "/auth/sms/verify", map[string]any{
		"name":       "测试用户",
		"phone":      "13800138000",
		"code":       currentSMSCodeFromAdmin(t, router, "13800138000"),
		"inviteCode": "VALID2026",
	})

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body.String())
	}

	var response sessionResponseBody
	decodeJSONResponse(t, recorder, &response)
	if response.Session.User == nil {
		t.Fatalf("expected session user, got %+v", response.Session)
	}
	if response.Session.User.Name != "测试用户" {
		t.Fatalf("expected verified user name to be preserved, got %q", response.Session.User.Name)
	}
	if response.Session.User.Phone == nil || *response.Session.User.Phone != "13800138000" {
		t.Fatalf("expected verified phone in session user, got %+v", response.Session.User)
	}
	_ = sessionCookieFromRecorder(t, recorder)
}

func TestAdminRoutesRequireBearerToken(t *testing.T) {
	t.Parallel()

	router := newAuthAdminTestRouter("admin-secret")
	recorder := performJSONRequest(t, router, http.MethodGet, "/admin/users", nil)

	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d: %s", recorder.Code, recorder.Body.String())
	}
}

func TestAdminUsersListReturnsCreatedUsers(t *testing.T) {
	t.Parallel()

	router := newAuthAdminTestRouter("admin-secret")
	_ = performJSONRequest(t, router, http.MethodPost, "/auth/password/sign-up", map[string]any{
		"name":       "Admin Alice",
		"email":      "admin-alice@example.com",
		"password":   "password123",
		"inviteCode": "VALID2026",
	})

	recorder := performAdminJSONRequest(t, router, http.MethodGet, "/admin/users?search=Alice", nil, "admin-secret")
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body.String())
	}

	var response struct {
		Items []adminUserResponse `json:"items"`
		Total int                 `json:"total"`
	}
	decodeJSONResponse(t, recorder, &response)
	if response.Total == 0 || len(response.Items) == 0 {
		t.Fatalf("expected at least one user, got %+v", response)
	}
	if response.Items[0].Email != "admin-alice@example.com" {
		t.Fatalf("expected created user in response, got %+v", response.Items[0])
	}
}

func TestAdminUsersListIncludesQQIdentityMetadata(t *testing.T) {
	t.Parallel()

	router := newAuthAdminTestRouterWithQQ("admin-secret", &stubQQOAuthClient{
		identity: service.OAuthSignInInput{
			Provider:        "qq",
			ProviderSubject: "openid-admin-qq-user",
			Name:            "QQ Admin User",
		},
	})

	prepare := performJSONRequest(t, router, http.MethodPost, "/auth/invite/prepare", map[string]any{
		"code": "VALID2026",
	})
	if prepare.Code != http.StatusNoContent {
		t.Fatalf("expected 204 from invite prepare, got %d: %s", prepare.Code, prepare.Body.String())
	}
	inviteCookie := cookieFromRecorderByName(t, prepare, inviteTicketCookieName)

	start := performJSONRequest(t, router, http.MethodGet, "/auth/oauth/qq/start", nil)
	if start.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from qq start, got %d: %s", start.Code, start.Body.String())
	}

	stateCookie := cookieFromRecorderByName(t, start, "lc_qq_oauth_state")
	callback := httptest.NewRequest(
		http.MethodGet,
		"/auth/oauth/qq/callback?code=qq-admin-user&state="+stateCookie.Value,
		nil,
	)
	callback.AddCookie(stateCookie)
	callback.AddCookie(inviteCookie)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, callback)
	if recorder.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from qq callback, got %d: %s", recorder.Code, recorder.Body.String())
	}

	adminRecorder := performAdminJSONRequest(t, router, http.MethodGet, "/admin/users?search=QQ%20Admin%20User", nil, "admin-secret")
	if adminRecorder.Code != http.StatusOK {
		t.Fatalf("expected 200 from admin users list, got %d: %s", adminRecorder.Code, adminRecorder.Body.String())
	}

	var response struct {
		Items []adminUserResponse `json:"items"`
		Total int                 `json:"total"`
	}
	decodeJSONResponse(t, adminRecorder, &response)
	if response.Total != 1 || len(response.Items) != 1 {
		t.Fatalf("expected one qq user in response, got %+v", response)
	}
	if response.Items[0].QQOpenID != "openid-admin-qq-user" {
		t.Fatalf("expected qq openid in admin response, got %+v", response.Items[0])
	}
	if len(response.Items[0].AuthMethods) == 0 || response.Items[0].AuthMethods[0] != "qq" {
		t.Fatalf("expected qq auth method in admin response, got %+v", response.Items[0].AuthMethods)
	}
}

func TestAdminUsersListIncludesWeChatIdentityMetadata(t *testing.T) {
	t.Parallel()

	router := newAuthAdminTestRouterWithWeChat("admin-secret", &stubWeChatOAuthClient{
		identity: service.OAuthSignInInput{
			Provider:        "wechat",
			ProviderSubject: "unionid-admin-wechat-user",
			Name:            "微信 Admin User",
		},
	})

	prepare := performJSONRequest(t, router, http.MethodPost, "/auth/invite/prepare", map[string]any{
		"code": "VALID2026",
	})
	if prepare.Code != http.StatusNoContent {
		t.Fatalf("expected 204 from invite prepare, got %d: %s", prepare.Code, prepare.Body.String())
	}
	inviteCookie := cookieFromRecorderByName(t, prepare, inviteTicketCookieName)

	start := performJSONRequest(t, router, http.MethodGet, "/auth/oauth/wechat/start", nil)
	if start.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from wechat start, got %d: %s", start.Code, start.Body.String())
	}

	stateCookie := cookieFromRecorderByName(t, start, "lc_wechat_oauth_state")
	callback := httptest.NewRequest(
		http.MethodGet,
		"/auth/oauth/wechat/callback?code=wechat-admin-user&state="+stateCookie.Value,
		nil,
	)
	callback.AddCookie(stateCookie)
	callback.AddCookie(inviteCookie)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, callback)
	if recorder.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected 307 from wechat callback, got %d: %s", recorder.Code, recorder.Body.String())
	}

	adminRecorder := performAdminJSONRequest(t, router, http.MethodGet, "/admin/users?search=%E5%BE%AE%E4%BF%A1%20Admin%20User", nil, "admin-secret")
	if adminRecorder.Code != http.StatusOK {
		t.Fatalf("expected 200 from admin users list, got %d: %s", adminRecorder.Code, adminRecorder.Body.String())
	}

	var response struct {
		Items []adminUserResponse `json:"items"`
		Total int                 `json:"total"`
	}
	decodeJSONResponse(t, adminRecorder, &response)
	if response.Total != 1 || len(response.Items) != 1 {
		t.Fatalf("expected one wechat user in response, got %+v", response)
	}
	if response.Items[0].WeChatSubject != "unionid-admin-wechat-user" {
		t.Fatalf("expected wechat openid in admin response, got %+v", response.Items[0])
	}
	if len(response.Items[0].AuthMethods) == 0 || response.Items[0].AuthMethods[0] != "wechat" {
		t.Fatalf("expected wechat auth method in admin response, got %+v", response.Items[0].AuthMethods)
	}

	invitesRecorder := performAdminJSONRequest(t, router, http.MethodGet, "/admin/invites?search=VALID2026", nil, "admin-secret")
	if invitesRecorder.Code != http.StatusOK {
		t.Fatalf("expected 200 from admin invites list, got %d: %s", invitesRecorder.Code, invitesRecorder.Body.String())
	}
	var invitesResponse struct {
		Items []adminInviteResponse `json:"items"`
	}
	decodeJSONResponse(t, invitesRecorder, &invitesResponse)
	if len(invitesResponse.Items) != 1 {
		t.Fatalf("expected one invite in admin response, got %+v", invitesResponse)
	}
	if invitesResponse.Items[0].UsedVia != "" {
		t.Fatalf("expected invite to remain unused after wechat sign-in, got %+v", invitesResponse.Items[0])
	}
}

func TestAdminSMSChallengesListAndDelete(t *testing.T) {
	t.Parallel()

	router := newAuthAdminTestRouter("admin-secret")
	sendCode := performJSONRequest(t, router, http.MethodPost, "/auth/sms/send", map[string]any{
		"phone": "13800138000",
	})
	if sendCode.Code != http.StatusOK {
		t.Fatalf("expected 200 from send code, got %d: %s", sendCode.Code, sendCode.Body.String())
	}

	listBefore := performAdminJSONRequest(t, router, http.MethodGet, "/admin/sms-challenges?search=13800138000", nil, "admin-secret")
	if listBefore.Code != http.StatusOK {
		t.Fatalf("expected 200 from sms list, got %d: %s", listBefore.Code, listBefore.Body.String())
	}
	var before struct {
		Items []adminSMSChallengeResponse `json:"items"`
	}
	decodeJSONResponse(t, listBefore, &before)
	if len(before.Items) != 1 {
		t.Fatalf("expected 1 sms challenge, got %+v", before)
	}

	deleted := performAdminJSONRequest(t, router, http.MethodDelete, "/admin/sms-challenges/13800138000", nil, "admin-secret")
	if deleted.Code != http.StatusNoContent {
		t.Fatalf("expected 204 from sms delete, got %d: %s", deleted.Code, deleted.Body.String())
	}

	listAfter := performAdminJSONRequest(t, router, http.MethodGet, "/admin/sms-challenges?search=13800138000", nil, "admin-secret")
	var after struct {
		Items []adminSMSChallengeResponse `json:"items"`
	}
	decodeJSONResponse(t, listAfter, &after)
	if len(after.Items) != 0 {
		t.Fatalf("expected sms challenge to be deleted, got %+v", after.Items)
	}
}

func TestAdminInvitesCreateListAndDisable(t *testing.T) {
	t.Parallel()

	router := newAuthAdminTestRouter("admin-secret")
	created := performAdminJSONRequest(t, router, http.MethodPost, "/admin/invites", map[string]any{
		"code":    "OPS2026",
		"message": "运营专用邀请码",
	}, "admin-secret")
	if created.Code != http.StatusCreated {
		t.Fatalf("expected 201 from create invite, got %d: %s", created.Code, created.Body.String())
	}

	listBefore := performAdminJSONRequest(t, router, http.MethodGet, "/admin/invites?search=OPS2026", nil, "admin-secret")
	if listBefore.Code != http.StatusOK {
		t.Fatalf("expected 200 from invite list, got %d: %s", listBefore.Code, listBefore.Body.String())
	}
	var before struct {
		Items []adminInviteResponse `json:"items"`
	}
	decodeJSONResponse(t, listBefore, &before)
	if len(before.Items) != 1 || before.Items[0].State != "valid" {
		t.Fatalf("expected created invite to be valid, got %+v", before.Items)
	}

	disabled := performAdminJSONRequest(t, router, http.MethodPost, "/admin/invites/OPS2026/disable", nil, "admin-secret")
	if disabled.Code != http.StatusNoContent {
		t.Fatalf("expected 204 from invite disable, got %d: %s", disabled.Code, disabled.Body.String())
	}

	listAfter := performAdminJSONRequest(t, router, http.MethodGet, "/admin/invites?search=OPS2026", nil, "admin-secret")
	var after struct {
		Items []adminInviteResponse `json:"items"`
	}
	decodeJSONResponse(t, listAfter, &after)
	if len(after.Items) != 1 || after.Items[0].State != "disabled" {
		t.Fatalf("expected invite to be disabled, got %+v", after.Items)
	}
}

func TestAdminCreateImpersonationSessionReturnsLoginURLAndPublicSessionFlag(t *testing.T) {
	t.Parallel()

	router := newAuthAdminTestRouter("admin-secret")
	signUp := performJSONRequest(t, router, http.MethodPost, "/auth/password/sign-up", map[string]any{
		"name":       "Alice",
		"email":      "impersonation-http@example.com",
		"password":   "password123",
		"inviteCode": "VALID2026",
	})
	if signUp.Code != http.StatusOK {
		t.Fatalf("expected 200 from sign up, got %d: %s", signUp.Code, signUp.Body.String())
	}
	var signUpBody sessionResponseBody
	decodeJSONResponse(t, signUp, &signUpBody)

	created := performAdminJSONRequest(t, router, http.MethodPost, "/admin/users/"+signUpBody.Session.User.ID+"/impersonation-sessions", map[string]any{
		"returnTo": "https://console.example.com/dashboard?tab=bots#section=users&session_token=old&panel=1&session_token=older",
		"reason":   "协助用户排查登录问题",
	}, "admin-secret")
	if created.Code != http.StatusOK {
		t.Fatalf("expected 200 from impersonation create, got %d: %s", created.Code, created.Body.String())
	}
	var response adminImpersonationSessionResponse
	decodeJSONResponse(t, created, &response)
	if !response.Impersonated || response.UserID != signUpBody.Session.User.ID {
		t.Fatalf("unexpected impersonation response: %+v", response)
	}
	if response.ExpiresAt != fixedHTTPTestNow().Add(30*time.Minute).UTC().Format(timeRFC3339Milli) {
		t.Fatalf("expected short impersonation expiry, got %s", response.ExpiresAt)
	}

	loginURL, err := url.Parse(response.LoginURL)
	if err != nil {
		t.Fatalf("parse login url: %v", err)
	}
	if loginURL.Scheme != "https" || loginURL.Host != "console.example.com" || loginURL.Path != "/dashboard" || loginURL.RawQuery != "tab=bots" {
		t.Fatalf("unexpected login url shape: %s", response.LoginURL)
	}
	fragmentValues, err := url.ParseQuery(loginURL.Fragment)
	if err != nil {
		t.Fatalf("parse login fragment: %v", err)
	}
	tokens := fragmentValues["session_token"]
	if len(tokens) != 1 || strings.TrimSpace(tokens[0]) == "" {
		t.Fatalf("expected exactly one session_token in fragment, got %#v from %q", tokens, loginURL.Fragment)
	}
	if fragmentValues.Get("section") != "users" || fragmentValues.Get("panel") != "1" {
		t.Fatalf("expected existing non-token fragment values to be preserved, got %q", loginURL.Fragment)
	}

	current := performJSONRequest(t, router, http.MethodGet, "/auth/session", nil, &http.Cookie{Name: sessionCookieName, Value: tokens[0]})
	if current.Code != http.StatusOK {
		t.Fatalf("expected 200 from impersonated current session, got %d: %s", current.Code, current.Body.String())
	}
	var currentBody sessionResponseBody
	decodeJSONResponse(t, current, &currentBody)
	if !currentBody.Session.Impersonated {
		t.Fatal("expected public session to expose impersonated=true")
	}
	var raw map[string]any
	decodeJSONResponse(t, current, &raw)
	sessionObject, ok := raw["session"].(map[string]any)
	if !ok {
		t.Fatalf("expected session object in response: %#v", raw)
	}
	if _, ok := sessionObject["impersonationReason"]; ok {
		t.Fatalf("public session must not expose impersonation reason: %s", current.Body.String())
	}
}

func TestAdminCreateImpersonationSessionValidatesReturnTo(t *testing.T) {
	t.Parallel()

	router := newAuthAdminTestRouter("admin-secret")
	signUp := performJSONRequest(t, router, http.MethodPost, "/auth/password/sign-up", map[string]any{
		"name":       "Alice",
		"email":      "impersonation-invalid-return@example.com",
		"password":   "password123",
		"inviteCode": "VALID2026",
	})
	var signUpBody sessionResponseBody
	decodeJSONResponse(t, signUp, &signUpBody)

	for _, returnTo := range []string{"", "/dashboard", "//console.example.com/dashboard", "javascript:alert(1)", "mailto:a@example.com"} {
		recorder := performAdminJSONRequest(t, router, http.MethodPost, "/admin/users/"+signUpBody.Session.User.ID+"/impersonation-sessions", map[string]any{
			"returnTo": returnTo,
			"reason":   "协助用户",
		}, "admin-secret")
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 for returnTo %q, got %d: %s", returnTo, recorder.Code, recorder.Body.String())
		}
	}
}

func TestAdminCreateImpersonationSessionAllowsStructuredAbsoluteReturnTo(t *testing.T) {
	t.Parallel()

	for _, returnTo := range []string{
		"http://console.example.com/path",
		"https://user:pass@console.example.com/path",
		"custom://console.example.com/path",
	} {
		loginURL, err := buildImpersonationLoginURL(returnTo, "tok_123")
		if err != nil {
			t.Fatalf("expected %q to be accepted: %v", returnTo, err)
		}
		parsed, err := url.Parse(loginURL)
		if err != nil {
			t.Fatalf("parse generated url: %v", err)
		}
		fragmentValues, err := url.ParseQuery(parsed.Fragment)
		if err != nil {
			t.Fatalf("parse generated fragment: %v", err)
		}
		if fragmentValues.Get("session_token") != "tok_123" {
			t.Fatalf("expected session_token fragment in %s", loginURL)
		}
	}
}

type sessionResponseBody struct {
	Session struct {
		User *struct {
			ID               string  `json:"id"`
			Name             string  `json:"name"`
			AvatarURL        string  `json:"avatarUrl"`
			Phone            *string `json:"phone"`
			InviteRequired   bool    `json:"inviteRequired"`
			RealnameVerified bool    `json:"realnameVerified"`
		} `json:"user"`
		PlanSelection *struct {
			Tier string `json:"tier"`
		} `json:"planSelection"`
		Impersonated bool `json:"impersonated"`
	} `json:"session"`
}

type profileResponseBody struct {
	User *struct {
		Name           string `json:"name"`
		AvatarURL      string `json:"avatarUrl"`
		InviteRequired bool   `json:"inviteRequired"`
	} `json:"user"`
}

type errorResponseBody struct {
	Code string `json:"code"`
}

func newAuthTestRouter() *gin.Engine {
	return newAuthTestRouterWithAvatarStore(nil)
}

func newAuthAdminTestRouter(adminToken string) *gin.Engine {
	return newAuthTestRouterWithOptions(nil, adminToken)
}

func newAuthAdminTestRouterWithQQ(adminToken string, client QQOAuthClient) *gin.Engine {
	gin.SetMode(gin.TestMode)
	store := service.NewMemoryStore(service.StoreOptions{
		Now:                fixedHTTPTestNow,
		SeedDefaultInvites: true,
	})
	svc := service.NewWithStore(store, service.Options{
		Now:        fixedHTTPTestNow,
		SessionTTL: 30 * 24 * time.Hour,
	})
	return NewRouter(svc, ServerConfig{
		CookieSecure:   true,
		CookieSameSite: http.SameSiteNoneMode,
		SessionTTL:     30 * 24 * time.Hour,
		PublicBaseURL:  "https://lightclaw.tech",
		AdminToken:     adminToken,
		QQOAuth: &QQOAuthConfig{
			AppID:           "1903611152",
			AppKey:          "test-app-key",
			RedirectURI:     "https://lightclaw.tech/auth/oauth/qq/callback",
			FrontendBaseURL: "https://lightclaw.pages.dev",
			PublicBaseURL:   "https://lightclaw.tech",
			Client:          client,
			StateTTL:        10 * time.Minute,
		},
	})
}

func newAuthAdminTestRouterWithWeChat(adminToken string, client WeChatOAuthClient) *gin.Engine {
	gin.SetMode(gin.TestMode)
	store := service.NewMemoryStore(service.StoreOptions{
		Now:                fixedHTTPTestNow,
		SeedDefaultInvites: true,
	})
	svc := service.NewWithStore(store, service.Options{
		Now:        fixedHTTPTestNow,
		SessionTTL: 30 * 24 * time.Hour,
	})
	return NewRouter(svc, ServerConfig{
		CookieSecure:   true,
		CookieSameSite: http.SameSiteNoneMode,
		SessionTTL:     30 * 24 * time.Hour,
		PublicBaseURL:  "https://lightclaw.tech",
		AdminToken:     adminToken,
		WeChatOAuth: &WeChatOAuthConfig{
			AppID:           "wx622c70c4608a3b23",
			AppSecret:       "wechat-app-secret",
			RedirectURI:     "https://lightclaw.tech/auth/oauth/wechat/callback",
			FrontendBaseURL: "https://lightclaw.pages.dev",
			PublicBaseURL:   "https://lightclaw.tech",
			Client:          client,
			StateTTL:        10 * time.Minute,
		},
	})
}

func newAuthTestRouterWithAvatarStore(avatarStore AvatarStore) *gin.Engine {
	return newAuthTestRouterWithOptions(avatarStore, "")
}

func newAuthTestRouterWithOptions(avatarStore AvatarStore, adminToken string) *gin.Engine {
	gin.SetMode(gin.TestMode)
	store := service.NewMemoryStore(service.StoreOptions{
		Now:                fixedHTTPTestNow,
		SeedDefaultInvites: true,
	})
	svc := service.NewWithStore(store, service.Options{
		Now:        fixedHTTPTestNow,
		SessionTTL: 30 * 24 * time.Hour,
	})
	return NewRouter(svc, ServerConfig{
		CookieSecure:   true,
		CookieSameSite: http.SameSiteNoneMode,
		SessionTTL:     30 * 24 * time.Hour,
		AvatarStore:    avatarStore,
		PublicBaseURL:  "https://lightclaw.tech",
		AdminToken:     defaultTestAdminToken(adminToken),
	})
}

func newAuthTestRouterWithRealname() *gin.Engine {
	gin.SetMode(gin.TestMode)
	store := service.NewMemoryStore(service.StoreOptions{
		Now:                fixedHTTPTestNow,
		SeedDefaultInvites: true,
	})
	svc := service.NewWithStore(store, service.Options{
		Now:              fixedHTTPTestNow,
		SessionTTL:       30 * 24 * time.Hour,
		RealnameVerifier: httpStubRealnameVerifier{},
		RealnameCipher:   httpStubRealnameCipher{},
	})
	return NewRouter(svc, ServerConfig{
		CookieSecure:   true,
		CookieSameSite: http.SameSiteNoneMode,
		SessionTTL:     30 * 24 * time.Hour,
		PublicBaseURL:  "https://lightclaw.tech",
		AdminToken:     testAdminToken,
	})
}

func performJSONRequest(
	t *testing.T,
	router http.Handler,
	method string,
	path string,
	body map[string]any,
	cookies ...*http.Cookie,
) *httptest.ResponseRecorder {
	t.Helper()

	var payload []byte
	if body != nil {
		var err error
		payload, err = json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal request body: %v", err)
		}
	}

	req := httptest.NewRequest(method, path, bytes.NewReader(payload))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for _, cookie := range cookies {
		req.AddCookie(cookie)
	}

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, req)
	return recorder
}

func sessionCookieFromRecorder(t *testing.T, recorder *httptest.ResponseRecorder) *http.Cookie {
	t.Helper()

	resp := recorder.Result()
	t.Cleanup(func() { _ = resp.Body.Close() })
	for _, cookie := range resp.Cookies() {
		if cookie.Name == sessionCookieName {
			return cookie
		}
	}
	t.Fatalf("session cookie %q not found", sessionCookieName)
	return nil
}

func performAdminJSONRequest(
	t *testing.T,
	router http.Handler,
	method string,
	path string,
	body map[string]any,
	adminToken string,
) *httptest.ResponseRecorder {
	t.Helper()

	var payload []byte
	if body != nil {
		var err error
		payload, err = json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal request body: %v", err)
		}
	}

	req := httptest.NewRequest(method, path, bytes.NewReader(payload))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Authorization", "Bearer "+adminToken)

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, req)
	return recorder
}

func decodeJSONResponse(t *testing.T, recorder *httptest.ResponseRecorder, target any) {
	t.Helper()

	if err := json.Unmarshal(recorder.Body.Bytes(), target); err != nil {
		t.Fatalf("decode response: %v; body=%s", err, recorder.Body.String())
	}
}

func performMultipartAvatarUploadRequest(
	t *testing.T,
	router http.Handler,
	path string,
	cookie *http.Cookie,
	content []byte,
) *httptest.ResponseRecorder {
	t.Helper()

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", "avatar.png")
	if err != nil {
		t.Fatalf("create form file: %v", err)
	}
	if _, err := part.Write(content); err != nil {
		t.Fatalf("write form file: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}

	req := httptest.NewRequest(http.MethodPut, path, &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.AddCookie(cookie)

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, req)
	return recorder
}

func testPNGBytes(t *testing.T) []byte {
	t.Helper()

	var body bytes.Buffer
	img := image.NewRGBA(image.Rect(0, 0, 8, 8))
	for y := 0; y < 8; y++ {
		for x := 0; x < 8; x++ {
			img.Set(x, y, color.RGBA{R: 0x44, G: 0x88, B: 0xcc, A: 0xff})
		}
	}
	if err := png.Encode(&body, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return body.Bytes()
}

type stubAvatarStore struct {
	objectKey            string
	signedURL            string
	storeErr             error
	lastUploadedUserID   string
	lastRemoteUserID     string
	lastRemoteURL        string
	lastDeletedObjectKey string
}

type httpStubRealnameVerifier struct{}

func (httpStubRealnameVerifier) Verify(_ context.Context, _ string, _ string) (service.RealnameProviderResult, error) {
	return service.RealnameProviderResult{Result: "0", RequestID: "req-http"}, nil
}

type httpStubRealnameCipher struct{}

func (httpStubRealnameCipher) Encrypt(plaintext string) (string, error) {
	return "enc(" + plaintext + ")", nil
}

func (s *stubAvatarStore) StoreAvatar(_ context.Context, userID string, _ []byte) (string, error) {
	if s.storeErr != nil {
		return "", s.storeErr
	}
	s.lastUploadedUserID = userID
	if s.objectKey == "" {
		s.objectKey = "avatars/" + userID + "/current.jpg"
	}
	return s.objectKey, nil
}

func (s *stubAvatarStore) SyncRemoteAvatar(_ context.Context, userID string, remoteURL string) (string, error) {
	s.lastRemoteUserID = userID
	s.lastRemoteURL = remoteURL
	if s.objectKey == "" {
		s.objectKey = "avatars/" + userID + "/current.jpg"
	}
	return s.objectKey, nil
}

func (s *stubAvatarStore) SignedAvatarURL(_ context.Context, objectKey string) (string, error) {
	if s.signedURL == "" {
		s.signedURL = "https://example.com/" + objectKey
	}
	return s.signedURL, nil
}

func (s *stubAvatarStore) DeleteAvatar(_ context.Context, objectKey string) error {
	s.lastDeletedObjectKey = objectKey
	return nil
}

func defaultTestAdminToken(token string) string {
	if token != "" {
		return token
	}
	return testAdminToken
}

func findSetCookie(t *testing.T, recorder *httptest.ResponseRecorder, name string) *http.Cookie {
	t.Helper()
	for _, cookie := range recorder.Result().Cookies() {
		if cookie.Name == name {
			return cookie
		}
	}
	t.Fatalf("expected set-cookie %q, got %v", name, recorder.Result().Cookies())
	return nil
}

func currentSMSCodeFromAdmin(t *testing.T, router http.Handler, phone string) string {
	t.Helper()

	recorder := performAdminJSONRequest(t, router, http.MethodGet, "/admin/sms-challenges?search="+phone, nil, testAdminToken)
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200 from sms challenge admin query, got %d: %s", recorder.Code, recorder.Body.String())
	}

	var response struct {
		Items []adminSMSChallengeResponse `json:"items"`
	}
	decodeJSONResponse(t, recorder, &response)
	for _, item := range response.Items {
		if item.Phone == phone {
			if item.Code == "" {
				t.Fatal("expected sms challenge code to be present")
			}
			return item.Code
		}
	}
	t.Fatalf("sms challenge for %s not found", phone)
	return ""
}

func fixedHTTPTestNow() time.Time {
	return time.Date(2026, 3, 20, 10, 0, 0, 0, time.UTC)
}
