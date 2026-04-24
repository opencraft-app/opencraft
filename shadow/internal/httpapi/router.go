package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"shadow/internal/shadow"
	"shadow/internal/telemetry"
	"shadow/internal/trade"
	"shadow/internal/wallet"

	otellog "go.opentelemetry.io/otel/log"
)

type API struct {
	service       *shadow.Service
	tradeService  *trade.Service
	walletService *wallet.Service
	opts          Options
}

type Options struct {
	CallbackToken       string
	PaymentConfirmToken string
	TradeService        *trade.Service
	WalletService       *wallet.Service
}

func New(service *shadow.Service) *API {
	return NewWithOptions(service, Options{})
}

func NewWithOptions(service *shadow.Service, opts Options) *API {
	return &API{service: service, tradeService: opts.TradeService, walletService: opts.WalletService, opts: opts}
}

func (a *API) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", a.handleHealth)
	mux.HandleFunc("POST /v1/shadow/register/send-sms", a.handleSendRegisterSMS)
	mux.HandleFunc("POST /v1/shadow/register/free-trial", a.handleRegisterFreeTrial)
	mux.HandleFunc("POST /v1/shadow/phone/send-sms", a.handleSendUpdatePhoneSMS)
	mux.HandleFunc("POST /v1/shadow/phone/verify", a.handleUpdatePhone)
	mux.HandleFunc("POST /v1/shadow/realname/authenticate", a.handleAuthenticateUser)
	mux.HandleFunc("GET /v1/shadow/realname/basic-auth", a.handleDescribeBasicAuth)
	mux.HandleFunc("GET /v1/shadow/payment/redirect", a.handleRedirect)
	mux.HandleFunc("GET /v1/shadow/packages", a.handleListPackages)
	mux.HandleFunc("POST /v1/shadow/package-orders", a.handleCreatePackageOrder)
	mux.HandleFunc("GET /v1/shadow/package-orders/{id}", a.handleGetPackageOrder)
	mux.HandleFunc("GET /v1/shadow/wallet", a.handleGetWallet)
	mux.HandleFunc("POST /internal/shadow/package-orders/{id}/confirm", a.handleConfirmPackageOrder)
	mux.HandleFunc("POST /internal/tencentcloud/account", a.handleTencentCloudCallback)
	return mux
}

func (a *API) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}

func (a *API) handleSendRegisterSMS(w http.ResponseWriter, r *http.Request) {
	var req shadow.SendRegisterSMSInput
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if req.ClientIP == "" {
		req.ClientIP = clientIP(r)
	}
	if err := a.service.SendRegisterSMS(r.Context(), req); err != nil {
		writeError(w, statusFromCloudError(err, http.StatusBadGateway), err)
		return
	}
	writeJSON(w, http.StatusNoContent, nil)
}

func (a *API) handleSendUpdatePhoneSMS(w http.ResponseWriter, r *http.Request) {
	var req shadow.SendUpdatePhoneSMSInput
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if req.ClientIP == "" {
		req.ClientIP = clientIP(r)
	}
	if err := a.service.SendUpdatePhoneSMS(r.Context(), req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusNoContent, nil)
}

func (a *API) handleRegisterFreeTrial(w http.ResponseWriter, r *http.Request) {
	var req shadow.RegisterFreeTrialInput
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if req.ClientIP == "" {
		req.ClientIP = clientIP(r)
	}
	if req.ClientUA == "" {
		req.ClientUA = r.UserAgent()
	}
	resp, err := a.service.RegisterFreeTrial(r.Context(), req)
	if err != nil {
		status := http.StatusBadGateway
		if err == shadow.ErrAlreadyRegistered {
			status = http.StatusConflict
		}
		writeError(w, status, err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func (a *API) handleUpdatePhone(w http.ResponseWriter, r *http.Request) {
	var req shadow.UpdatePhoneInput
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if err := a.service.UpdatePhone(r.Context(), req); err != nil {
		status := http.StatusBadRequest
		if err == shadow.ErrDuplicatePhone {
			status = http.StatusConflict
		}
		writeError(w, status, err)
		return
	}
	writeJSON(w, http.StatusNoContent, nil)
}

func (a *API) handleAuthenticateUser(w http.ResponseWriter, r *http.Request) {
	var req shadow.AuthenticateUserInput
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if err := a.service.AuthenticateUser(r.Context(), req); err != nil {
		writeError(w, statusFromCloudError(err, http.StatusBadGateway), err)
		return
	}
	writeJSON(w, http.StatusNoContent, nil)
}

func (a *API) handleDescribeBasicAuth(w http.ResponseWriter, r *http.Request) {
	userID := strings.TrimSpace(r.URL.Query().Get("user_id"))
	if userID == "" {
		writeError(w, http.StatusBadRequest, errInvalid("user_id"))
		return
	}
	out, err := a.service.DescribeBasicAuth(r.Context(), userID)
	if err != nil {
		writeError(w, statusFromCloudError(err, http.StatusBadGateway), err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *API) handleRedirect(w http.ResponseWriter, r *http.Request) {
	userID := strings.TrimSpace(r.URL.Query().Get("user_id"))
	if userID == "" {
		writeError(w, http.StatusBadRequest, errInvalid("user_id"))
		return
	}
	mode := r.URL.Query().Get("mode")
	if mode == "" {
		writeError(w, http.StatusBadRequest, errInvalid("mode"))
		return
	}
	location, err := a.service.BuildPaymentRedirect(r.Context(), shadow.RedirectInput{
		UserID:  userID,
		Mode:    mode,
		Console: r.URL.Query().Get("console"),
	}, r.UserAgent())
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"location": location})
}

type callbackEnvelope struct {
	Version       string `json:"version"`
	Caller        string `json:"caller"`
	ComponentName string `json:"componentName"`
	EventID       string `json:"eventId"`
	Timestamp     int64  `json:"timestamp"`
	Interface     struct {
		InterfaceName string `json:"interfaceName"`
		Para          struct {
			UserID   string `json:"user_id"`
			AuthCode string `json:"auth_code"`
		} `json:"para"`
	} `json:"interface"`
}

func (a *API) handleTencentCloudCallback(w http.ResponseWriter, r *http.Request) {
	logger := telemetry.Logger("shadow/internal/httpapi")

	if a.opts.CallbackToken != "" {
		token := r.URL.Query().Get("token")
		if token == "" {
			token = r.Header.Get("X-Shadow-Callback-Token")
		}
		if token != a.opts.CallbackToken {
			telemetry.Warn(r.Context(), logger, "tencentcloud callback forbidden",
				otellog.String("remote_addr", r.RemoteAddr),
				otellog.Bool("token_present", token != ""),
			)
			writeError(w, http.StatusForbidden, errors.New("forbidden"))
			return
		}
	}
	var req callbackEnvelope
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		telemetry.Error(r.Context(), logger, "tencentcloud callback bad_request",
			otellog.String("remote_addr", r.RemoteAddr),
			otellog.String("error", err.Error()),
		)
		writeError(w, http.StatusBadRequest, err)
		return
	}
	telemetry.Info(r.Context(), logger, "tencentcloud callback received",
		otellog.String("interface", req.Interface.InterfaceName),
		otellog.String("event_id", req.EventID),
		otellog.String("caller", req.Caller),
		otellog.String("component", req.ComponentName),
		otellog.String("remote_addr", r.RemoteAddr),
		otellog.String("user_id", req.Interface.Para.UserID),
		otellog.Bool("has_auth_code", req.Interface.Para.AuthCode != ""),
		otellog.Int("auth_code_len", len(req.Interface.Para.AuthCode)),
	)
	switch req.Interface.InterfaceName {
	case "qcloud.saas.checkSaaSAccountExist":
		exist, err := a.service.CheckSaaSAccountExist(r.Context(), req.Interface.Para.UserID)
		if err != nil {
			telemetry.Error(r.Context(), logger, "tencentcloud callback failed",
				otellog.String("interface", req.Interface.InterfaceName),
				otellog.String("event_id", req.EventID),
				otellog.String("remote_addr", r.RemoteAddr),
				otellog.String("error", err.Error()),
			)
			writeCallbackError(w, err)
			return
		}
		telemetry.Info(r.Context(), logger, "tencentcloud callback success",
			otellog.String("interface", req.Interface.InterfaceName),
			otellog.String("event_id", req.EventID),
			otellog.String("remote_addr", r.RemoteAddr),
			otellog.Bool("exist", exist),
		)
		writeJSON(w, http.StatusOK, map[string]any{
			"returnCode":    0,
			"returnMessage": "ok",
			"data": map[string]any{
				"exist": exist,
			},
		})
	case "qcloud.saas.checkSaaSAuthCode":
		userID, err := a.service.CheckSaaSAuthCode(r.Context(), req.Interface.Para.AuthCode)
		if err != nil {
			telemetry.Error(r.Context(), logger, "tencentcloud callback failed",
				otellog.String("interface", req.Interface.InterfaceName),
				otellog.String("event_id", req.EventID),
				otellog.String("remote_addr", r.RemoteAddr),
				otellog.String("error", err.Error()),
			)
			writeCallbackError(w, err)
			return
		}
		telemetry.Info(r.Context(), logger, "tencentcloud callback success",
			otellog.String("interface", req.Interface.InterfaceName),
			otellog.String("event_id", req.EventID),
			otellog.String("remote_addr", r.RemoteAddr),
			otellog.String("user_id", userID),
		)
		writeJSON(w, http.StatusOK, map[string]any{
			"returnCode":    0,
			"returnMessage": "ok",
			"data": map[string]any{
				"user_id": userID,
			},
		})
	default:
		telemetry.Warn(r.Context(), logger, "tencentcloud callback unsupported",
			otellog.String("interface", req.Interface.InterfaceName),
			otellog.String("event_id", req.EventID),
			otellog.String("remote_addr", r.RemoteAddr),
		)
		writeJSON(w, http.StatusOK, map[string]any{
			"returnCode":    1,
			"returnMessage": "unsupported interfaceName",
		})
	}
}

func (a *API) handleListPackages(w http.ResponseWriter, r *http.Request) {
	if a.tradeService == nil {
		writeError(w, http.StatusNotImplemented, errors.New("package trade is not configured"))
		return
	}
	products, err := a.tradeService.ListProducts(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"packages": products})
}

func (a *API) handleCreatePackageOrder(w http.ResponseWriter, r *http.Request) {
	if a.tradeService == nil {
		writeError(w, http.StatusNotImplemented, errors.New("package trade is not configured"))
		return
	}
	var req struct {
		UserID      string `json:"user_id"`
		PackageCode string `json:"package_code"`
		Platform    string `json:"platform"`
		ReturnURL   string `json:"return_url"`
		CancelURL   string `json:"cancel_url"`
		PayScene    string `json:"pay_scene"`
		Application string `json:"application"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	out, err := a.tradeService.CreatePackageOrder(r.Context(), trade.CreatePackageOrderInput{
		UserID:      req.UserID,
		PackageCode: req.PackageCode,
		Platform:    req.Platform,
		ReturnURL:   req.ReturnURL,
		CancelURL:   req.CancelURL,
		PayScene:    req.PayScene,
		Application: req.Application,
	})
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, out.Order)
}

func (a *API) handleGetPackageOrder(w http.ResponseWriter, r *http.Request) {
	if a.tradeService == nil {
		writeError(w, http.StatusNotImplemented, errors.New("package trade is not configured"))
		return
	}
	order, err := a.tradeService.GetPackageOrder(r.Context(), r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	writeJSON(w, http.StatusOK, order)
}

func (a *API) handleGetWallet(w http.ResponseWriter, r *http.Request) {
	if a.walletService == nil {
		writeError(w, http.StatusNotImplemented, errors.New("wallet is not configured"))
		return
	}
	userID := strings.TrimSpace(r.URL.Query().Get("user_id"))
	if userID == "" {
		writeError(w, http.StatusBadRequest, errInvalid("user_id"))
		return
	}
	account, err := a.walletService.GetAccount(r.Context(), userID)
	if err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	writeJSON(w, http.StatusOK, account)
}

func (a *API) handleConfirmPackageOrder(w http.ResponseWriter, r *http.Request) {
	if a.tradeService == nil {
		writeError(w, http.StatusNotImplemented, errors.New("package trade is not configured"))
		return
	}
	if a.opts.PaymentConfirmToken != "" {
		token := r.URL.Query().Get("token")
		if token == "" {
			token = r.Header.Get("X-Shadow-Payment-Confirm-Token")
		}
		if token != a.opts.PaymentConfirmToken {
			writeError(w, http.StatusForbidden, errors.New("forbidden"))
			return
		}
	}
	out, err := a.tradeService.ConfirmPackageOrder(r.Context(), r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func writeCallbackError(w http.ResponseWriter, err error) {
	writeJSON(w, http.StatusOK, map[string]any{
		"returnCode":    1,
		"returnMessage": err.Error(),
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	if v == nil {
		w.WriteHeader(status)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func statusFromCloudError(err error, fallback int) int {
	if err == nil {
		return fallback
	}
	msg := err.Error()
	switch {
	case strings.Contains(msg, "Code=LimitExceeded.SendFrequency"),
		strings.Contains(msg, "Code=FailedOperation.TooFrequently"),
		strings.Contains(msg, "Code=LimitExceeded.VerifyCodeOverErrorLimit"):
		return http.StatusTooManyRequests
	default:
		return fallback
	}
}

func clientIP(r *http.Request) string {
	if v := r.Header.Get("X-Forwarded-For"); v != "" {
		return v
	}
	return "127.0.0.1"
}

func errInvalid(field string) error {
	return &fieldError{Field: field}
}

type fieldError struct {
	Field string
}

func (e *fieldError) Error() string {
	return e.Field + " is invalid"
}
