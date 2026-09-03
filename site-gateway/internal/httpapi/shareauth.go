package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"git.woa.com/wisp/mono/site-gateway/internal/siteauth"
)

const (
	siteSharePath     = "/__lightvela/share"
	shareCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	shareCodeLength   = 6
	maxShareFormBytes = 2048
)

var (
	ErrShareCodeInvalid = errors.New("invalid website share code")
	ErrShareRateLimited = errors.New("website share code rate limited")
	ErrShareUnavailable = errors.New("website share verification unavailable")
)

type ShareVerification struct {
	Generation string
	ExpiresAt  time.Time
}

type ShareCodeVerifier interface {
	Verify(ctx context.Context, siteID, code, clientIP string) (ShareVerification, error)
}

type ctlShareCodeVerifier struct {
	baseURL    string
	token      string
	httpClient *http.Client
}

func NewCTLShareCodeVerifier(baseURL, token string, httpClient *http.Client) ShareCodeVerifier {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 3 * time.Second}
	}
	return &ctlShareCodeVerifier{
		baseURL:    strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		token:      strings.TrimSpace(token),
		httpClient: httpClient,
	}
}

func (v *ctlShareCodeVerifier) Verify(ctx context.Context, siteID, code, clientIP string) (ShareVerification, error) {
	body, err := json.Marshal(map[string]string{"code": code})
	if err != nil {
		return ShareVerification{}, ErrShareUnavailable
	}
	endpoint := v.baseURL + "/internal/ctl/websites/sites/" + url.PathEscape(siteID) + "/share-code/verify"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return ShareVerification{}, ErrShareUnavailable
	}
	req.Header.Set("Content-Type", "application/json")
	if v.token != "" {
		req.Header.Set("X-Internal-Token", v.token)
	}
	if clientIP != "" {
		req.Header.Set("X-Site-Client-IP", clientIP)
	}
	resp, err := v.httpClient.Do(req)
	if err != nil {
		return ShareVerification{}, ErrShareUnavailable
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusForbidden:
		return ShareVerification{}, ErrShareCodeInvalid
	case http.StatusTooManyRequests:
		return ShareVerification{}, ErrShareRateLimited
	default:
		return ShareVerification{}, ErrShareUnavailable
	}
	var envelope struct {
		Data struct {
			Verified        bool      `json:"verified"`
			ShareGeneration string    `json:"share_generation"`
			ShareExpiresAt  time.Time `json:"share_expires_at"`
		} `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&envelope); err != nil ||
		!envelope.Data.Verified || strings.TrimSpace(envelope.Data.ShareGeneration) == "" || envelope.Data.ShareExpiresAt.IsZero() {
		return ShareVerification{}, ErrShareUnavailable
	}
	return ShareVerification{
		Generation: strings.TrimSpace(envelope.Data.ShareGeneration),
		ExpiresAt:  envelope.Data.ShareExpiresAt.UTC(),
	}, nil
}

func (h *SiteHandler) redirectToSharePage(w http.ResponseWriter, r *http.Request, returnTo string) {
	target := &url.URL{Path: siteSharePath}
	target.RawQuery = url.Values{"return_to": []string{safeReturnTo(returnTo)}}.Encode()
	writeAuthRedirect(w, r, target.String())
}

func (h *SiteHandler) handleSiteShare(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, HEAD, POST")
		h.renderSharePage(w, r, http.StatusMethodNotAllowed, "/", "方法不被支持")
		return
	}
	siteID, _, ok := h.resolveSite(w, r)
	if !ok {
		return
	}
	resolved, err := h.resolveSiteHost(r.Context(), r.Host)
	if err != nil || resolved.SiteID != siteID {
		h.renderSharePage(w, r, http.StatusBadGateway, "/", "站点暂时无法访问")
		return
	}
	site, err := h.sites.BySiteID(r.Context(), siteID)
	if err != nil || site == nil {
		h.renderSharePage(w, r, http.StatusBadGateway, "/", "站点暂时无法访问")
		return
	}
	if !site.ShareAccessActiveAt(h.authNow()) {
		h.redirectToSiteAuth(w, r, resolved, safeReturnTo(r.URL.Query().Get("return_to")))
		return
	}
	returnTo := safeReturnTo(r.URL.Query().Get("return_to"))
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		h.renderSharePage(w, r, http.StatusOK, returnTo, "")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxShareFormBytes)
	if err := r.ParseForm(); err != nil {
		h.renderSharePage(w, r, http.StatusBadRequest, "/", "请求格式不正确")
		return
	}
	returnTo = safeReturnTo(r.Form.Get("return_to"))
	code := strings.ToUpper(strings.TrimSpace(r.Form.Get("code")))
	if !validShareCode(code) {
		h.renderSharePage(w, r, http.StatusForbidden, returnTo, "分享码不正确")
		return
	}
	if h.auth.ShareVerifier == nil || h.auth.TokenCodec == nil {
		h.renderSharePage(w, r, http.StatusServiceUnavailable, returnTo, "验证服务暂时不可用")
		return
	}
	verification, err := h.auth.ShareVerifier.Verify(r.Context(), siteID, code, shareClientIP(r, h.auth.TrustProxyHeaders))
	if err != nil {
		switch {
		case errors.Is(err, ErrShareCodeInvalid):
			h.renderSharePage(w, r, http.StatusForbidden, returnTo, "分享码不正确")
		case errors.Is(err, ErrShareRateLimited):
			h.renderSharePage(w, r, http.StatusTooManyRequests, returnTo, "尝试次数过多，请稍后再试")
		default:
			h.renderSharePage(w, r, http.StatusServiceUnavailable, returnTo, "验证服务暂时不可用")
		}
		return
	}
	remaining := verification.ExpiresAt.Sub(h.authNow())
	if strings.TrimSpace(verification.Generation) == "" || remaining < time.Second || remaining > 30*24*time.Hour {
		h.renderSharePage(w, r, http.StatusServiceUnavailable, returnTo, "验证服务暂时不可用")
		return
	}
	nonce, err := randomValue(32)
	if err != nil {
		h.renderSharePage(w, r, http.StatusInternalServerError, returnTo, "验证服务暂时不可用")
		return
	}
	raw, err := h.auth.TokenCodec.SealShareSession(siteauth.ShareSessionClaims{
		SiteID: siteID, SiteHost: resolved.Host, Generation: verification.Generation, Nonce: nonce,
	}, verification.ExpiresAt)
	if err != nil {
		h.renderSharePage(w, r, http.StatusInternalServerError, returnTo, "验证服务暂时不可用")
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name: shareSessionCookie, Value: raw, Path: "/", MaxAge: int(remaining / time.Second), Expires: verification.ExpiresAt,
		HttpOnly: true, Secure: true, SameSite: http.SameSiteLaxMode,
	})
	writeAuthRedirect(w, r, returnTo)
}

func validShareCode(code string) bool {
	if len(code) != shareCodeLength {
		return false
	}
	for _, char := range code {
		if !strings.ContainsRune(shareCodeAlphabet, char) {
			return false
		}
	}
	return true
}

func shareClientIP(r *http.Request, trustProxyHeaders bool) string {
	if r == nil || !trustProxyHeaders {
		return ""
	}
	for _, candidate := range strings.Split(r.Header.Get("X-Forwarded-For"), ",") {
		if parsed := net.ParseIP(strings.TrimSpace(candidate)); parsed != nil {
			return parsed.String()
		}
	}
	return ""
}

type sharePageData struct {
	ReturnTo  string
	OwnerURL  string
	ErrorText string
}

var sharePageTemplate = template.Must(template.New("share-page").Parse(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>使用分享码访问 | LightVela</title><style>
:root{--page-bg:#f7f7f5;--surface:#fff;--text-primary:#101216;--text-secondary:rgba(0,0,0,.5);--text-tertiary:rgba(0,0,0,.4);--button-bg:#101216;--button-hover:rgba(0,0,0,.85);--border:rgba(0,0,0,.08);--border-strong:rgba(0,0,0,.14);--danger:#cf3d4c;--danger-bg:#fff7f7;--shadow:0 24px 64px -34px rgba(0,0,0,.3)}
*{box-sizing:border-box}html{background:var(--page-bg)}body{margin:0;min-height:100vh;min-height:100svh;display:grid;place-items:center;padding:40px 24px;background:var(--page-bg);color:var(--text-primary);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}.page-shell{width:min(100%,412px)}.brand-lockup{display:flex;align-items:center;justify-content:center;height:28px;color:#000}.brand-lockup svg{display:block;width:100px;height:auto}.card{margin-top:24px;padding:40px 36px 32px;border:1px solid var(--border);border-radius:12px;background:var(--surface);box-shadow:var(--shadow)}.heading{text-align:center}.heading h1{margin:0;font-size:28px;line-height:1.2;font-weight:500;letter-spacing:-.025em;color:rgba(0,0,0,.9)}.heading p{margin:13px auto 0;max-width:300px;color:var(--text-secondary);font-size:14px;line-height:1.65}.share-form{margin-top:32px}.share-input{width:100%;height:48px;padding:0 14px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text-primary);font:600 17px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:.2em;text-align:center;text-transform:uppercase;caret-color:var(--text-primary);outline:0}.share-input::placeholder{color:rgba(0,0,0,.34);font-size:14px;font-weight:400;letter-spacing:0}.share-input:hover{border-color:var(--border-strong)}.share-input:focus-visible{border-color:var(--border-strong);box-shadow:0 0 0 3px rgba(0,0,0,.06)}.share-input[aria-invalid="true"]{border-color:rgba(207,61,76,.62);background:var(--danger-bg);box-shadow:0 0 0 3px rgba(207,61,76,.08)}.field-help{margin:8px 2px 0;color:var(--text-tertiary);font-size:12px}.field-error{margin:6px 2px 0;color:var(--danger);font-size:12px;font-weight:600}.primary-action,.owner{display:inline-flex;align-items:center;justify-content:center;width:100%;height:44px;border-radius:999px;font-family:inherit;font-size:14px;font-weight:600;line-height:1;cursor:pointer}.primary-action{margin-top:22px;border:1px solid var(--button-bg);background:var(--button-bg);color:#fff}.primary-action:hover{border-color:var(--button-hover);background:var(--button-hover)}.primary-action:focus-visible,.owner:focus-visible{outline:2px solid rgba(0,0,0,.32);outline-offset:3px}.divider{display:flex;align-items:center;gap:12px;margin:24px 0 18px;color:var(--text-tertiary);font-size:11px}.divider::before,.divider::after{content:"";height:1px;flex:1;background:var(--border)}.owner-hint{margin:0 0 11px;text-align:center;color:var(--text-tertiary);font-size:12px}.owner{border:1px solid #e6e9ef;background:#fff;color:#202020;text-decoration:none}.owner:hover{border-color:var(--border-strong);background:rgba(0,0,0,.025)}.trust{margin:18px 0 0;text-align:center;color:var(--text-tertiary);font-size:11px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media (max-width:520px){body{place-items:start center;padding:28px 16px}.brand-lockup{margin-top:2px}.card{margin-top:22px;padding:36px 24px 28px}.heading h1{font-size:26px}.share-form{margin-top:28px}.trust{padding:0 10px}}
@media (prefers-contrast:more){.card,.share-input,.owner{border-color:rgba(0,0,0,.32)}}
</style></head><body><div class="page-shell"><header class="brand-lockup" aria-label="LightVela">
<svg aria-hidden="true" viewBox="0 0 93 26" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M46.372 8.946h2.9V11.2h-2.9v6.11c0 .528.428.955.955.955h.063c.704 0 1.018-.203 1.018-.203v2.368s-.616.313-1.305.313h-.344a2.865 2.865 0 0 1-2.865-2.865V11.2h-2.28l4.758-5.775zM37.694 20.74V14.5q0-1.08-.698-1.779-.675-.698-1.757-.698-.72 0-1.284.315-.563.315-.879.879-.315.563-.315 1.284l-.969-.54q0-1.24.541-2.186a3.9 3.9 0 0 1 1.487-1.51 4.2 4.2 0 0 1 2.162-.562q1.217 0 2.163.54t1.486 1.51q.54.945.541 2.207v6.78zm-7.41 0V4.522h2.477V20.74zm-8.455 4.733q-1.712 0-2.996-.63a5.2 5.2 0 0 1-2.073-1.735l1.622-1.622q.654.81 1.487 1.216t2.005.406q1.464 0 2.32-.766.856-.744.856-2.05v-2.658l.428-2.388-.428-2.41V11.07l2.478-1.141v10.362q0 1.554-.721 2.703a4.9 4.9 0 0 1-2.005 1.825q-1.284.653-2.973.653m-.113-4.956q-1.441 0-2.613-.698a5.2 5.2 0 0 1-1.825-1.96q-.653-1.24-.653-2.77 0-1.533.654-2.749a5.1 5.1 0 0 1 1.824-1.915q1.172-.72 2.613-.72 1.284 0 2.253.518a3.77 3.77 0 0 1 1.509 1.441q.54.901.54 2.118v2.658q0 1.194-.563 2.117A3.77 3.77 0 0 1 23.946 20q-.969.518-2.23.518m.496-2.343q.9 0 1.576-.383t1.037-1.058q.383-.698.383-1.622t-.383-1.6a2.57 2.57 0 0 0-1.037-1.08q-.675-.384-1.576-.384t-1.6.383q-.675.383-1.058 1.082-.384.675-.383 1.599 0 .9.383 1.6.383.698 1.058 1.08.699.384 1.6.383m-10.144 2.568V9.93h2.478v10.813zm1.24-12.795q-.631 0-1.06-.428a1.48 1.48 0 0 1-.405-1.059q0-.63.406-1.059a1.44 1.44 0 0 1 1.058-.428q.654 0 1.059.428.405.429.405 1.06 0 .63-.405 1.058t-1.059.428M0 20.743V4.974h2.59v15.769zm1.78 0v-2.366h8.244l-.983 2.366zm55.029.057L50.41 4.974h2.827l4.996 12.82h-.995l5.042-12.82h2.78l-6.443 15.827zm20.255 0V4.522h2.487V20.8zm-7.412.226q-1.627 0-2.94-.723a5.67 5.67 0 0 1-2.056-2.035q-.747-1.29-.747-2.894t.747-2.871a5.54 5.54 0 0 1 2.012-2.035 5.6 5.6 0 0 1 2.848-.746q1.516 0 2.668.7a4.9 4.9 0 0 1 1.832 1.922q.678 1.221.678 2.781 0 .272-.045.566-.024.27-.09.61H65.65v-2.035h7.62l-.927.814q-.046-.994-.385-1.673a2.4 2.4 0 0 0-.972-1.04q-.61-.362-1.515-.362-.95 0-1.65.407a2.77 2.77 0 0 0-1.085 1.153q-.385.724-.385 1.741t.407 1.786 1.153 1.199q.746.406 1.718.407.837 0 1.538-.294a3.2 3.2 0 0 0 1.22-.86l1.583 1.606a5.1 5.1 0 0 1-1.921 1.401 6.1 6.1 0 0 1-2.397.475m16.887 0q-1.47 0-2.668-.746a5.5 5.5 0 0 1-1.877-2.012q-.678-1.29-.678-2.871 0-1.606.678-2.872a5.43 5.43 0 0 1 1.877-2.034 4.84 4.84 0 0 1 2.668-.77q1.243 0 2.193.543.972.521 1.537 1.447.565.928.565 2.103v3.12q0 1.176-.565 2.103a3.94 3.94 0 0 1-1.515 1.47q-.972.52-2.215.52m.407-2.351q1.38 0 2.215-.927.86-.928.86-2.374 0-.971-.385-1.718a2.77 2.77 0 0 0-1.085-1.153q-.678-.43-1.605-.43-.904 0-1.605.43a2.97 2.97 0 0 0-1.086 1.153q-.384.746-.384 1.718t.384 1.718q.407.747 1.086 1.176.7.407 1.605.407m2.916 2.125v-2.916l.43-2.646-.43-2.622v-1.46l2.487-1.208V20.8z"/></svg></header>
<main class="card"><div class="heading"><h1>使用分享码访问</h1><p>请输入站点所有者提供的 6 位分享码</p></div>
<form class="share-form" method="post" action="` + siteSharePath + `"><input type="hidden" name="return_to" value="{{.ReturnTo}}"><label class="sr-only" for="share-code">分享码</label><input class="share-input" id="share-code" name="code" type="text" maxlength="6" minlength="6" pattern="[A-HJ-NP-Z2-9]{6}" placeholder="请输入分享码" autocomplete="off" autocapitalize="characters" spellcheck="false" inputmode="text" required aria-describedby="share-help share-error" aria-invalid="{{if .ErrorText}}true{{else}}false{{end}}"{{if .ErrorText}} aria-errormessage="share-error"{{end}}><p id="share-help" class="field-help">支持大写字母与数字，不区分大小写</p>{{if .ErrorText}}<p id="share-error" class="field-error" role="alert" aria-live="polite">{{.ErrorText}}</p>{{else}}<span id="share-error" class="sr-only" aria-live="polite"></span>{{end}}<button class="primary-action" type="submit">进入站点</button></form>
<div class="divider" aria-hidden="true"><span>或</span></div><p class="owner-hint">站点所有者无需分享码，可直接登录</p><a class="owner" href="{{.OwnerURL}}">使用 LightVela 账号登录</a></main><p class="trust">LightVela 安全访问</p></div></body></html>`))

func (h *SiteHandler) renderSharePage(w http.ResponseWriter, r *http.Request, status int, returnTo, errorText string) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow, noarchive")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	if r.Method == http.MethodHead {
		return
	}
	data := sharePageData{
		ReturnTo:  safeReturnTo(returnTo),
		OwnerURL:  siteAuthStartPath + "?" + url.Values{"return_to": []string{safeReturnTo(returnTo)}}.Encode(),
		ErrorText: errorText,
	}
	if err := sharePageTemplate.Execute(w, data); err != nil && h.logger != nil {
		h.logger.Printf("render share page failed: %v", fmt.Errorf("template execution: %w", err))
	}
}
