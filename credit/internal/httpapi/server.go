package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"git.woa.com/wisp/mono/credit/internal/authcode"
	"git.woa.com/wisp/mono/credit/internal/service"
	"git.woa.com/wisp/mono/credit/internal/store"
	"git.woa.com/wisp/mono/credit/internal/tradeclient"
)

type Server struct {
	svc   *service.Service
	store store.Store
	trade tradeService
	auth  authcode.Store
	token string
}

const wechatPaymentAppID = "wxf95ea3ae45d5304f"

type tradeService interface {
	Inquiry(context.Context, tradeclient.InquiryRequest) (map[string]any, error)
	PlaceOrder(context.Context, tradeclient.OrderRequest) (*tradeclient.OrderResult, error)
	PlaceOrderAndPay(context.Context, tradeclient.OrderRequest) (map[string]any, error)
	GeneratePayURL(context.Context, string, tradeclient.PayURLRequest) (*tradeclient.PayURLResult, error)
	RefundPackage(context.Context, string, tradeclient.RefundRequest) (map[string]any, error)
}

type userOrderRequest struct {
	ProductID string `json:"product_id"`
	TimeSpan  int    `json:"time_span"`
	TimeUnit  string `json:"time_unit"`
}

type userOrderResponse struct {
	BigOrderID string `json:"bigOrderId"`
	DealName   string `json:"dealName"`
	AuthCode   string `json:"auth_code"`
}

type userOrderURLRequest struct {
	DealName  string `json:"deal_name"`
	AuthCode  string `json:"auth_code,omitempty"`
	Platform  string `json:"platform,omitempty"`
	WxOpenID  string `json:"wx_open_id,omitempty"`
	CancelURL string `json:"cancel_url,omitempty"`
	ReturnURL string `json:"return_url,omitempty"`
}

type userOrderURLResponse struct {
	DealName   string  `json:"deal_name"`
	PayURL     string  `json:"pay_url"`
	TokenID    *string `json:"token_id,omitempty"`
	OrderID    *string `json:"order_id,omitempty"`
	MidasAppID *string `json:"midas_app_id,omitempty"`
	NeedCharge int     `json:"need_charge"`
	Uin        string  `json:"uin,omitempty"`
	AppID      string  `json:"app_id,omitempty"`
}

func NewRouter(svc *service.Service, st store.Store, trade tradeService, auth authcode.Store, internalToken string) http.Handler {
	server := &Server{svc: svc, store: st, trade: trade, auth: auth, token: strings.TrimSpace(internalToken)}
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", server.health)
	mux.HandleFunc("/v1/credit/products", server.products)
	mux.HandleFunc("/v1/credit/inquiry", server.inquiry)
	mux.HandleFunc("/v1/credit/packages/order", server.order)
	mux.HandleFunc("/v1/credit/packages/order-url", server.orderURL)
	mux.HandleFunc("/v1/credit/packages/order-and-pay", server.orderAndPay)
	mux.HandleFunc("/v1/credit/packages", server.userCredits)
	mux.HandleFunc("/v1/credit/packages/", server.userPackageAction)
	mux.HandleFunc("/internal/credit/products/", server.requireInternal(server.internalProduct))
	mux.HandleFunc("/internal/credit/packages/complete", server.requireInternal(server.internalComplete))
	mux.HandleFunc("/internal/credit/packages/used-amount", server.requireInternal(server.internalUsedAmount))
	mux.HandleFunc("/internal/credit/packages/app-ids", server.requireInternal(server.internalResourceAppIDs))
	mux.HandleFunc("/internal/credit/packages/by-owner", server.requireInternal(server.internalUserResources))
	mux.HandleFunc("/internal/credit/packages/query-resources", server.requireInternal(server.internalQueryResources))
	mux.HandleFunc("/internal/credit/admin/packages", server.requireConfiguredInternal(server.adminPackages))
	mux.HandleFunc("/internal/credit/admin/packages/", server.requireConfiguredInternal(server.adminPackageAction))
	mux.HandleFunc("/internal/credit/packages/", server.requireInternal(server.internalPackageAction))
	return mux
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "data": map[string]string{"status": "ok"}})
}

func (s *Server) products(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	products, err := s.store.ListOnlineProducts(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "data": products})
}

func (s *Server) inquiry(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	var body userOrderRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	req := tradeclient.InquiryRequest{
		ExternalUserID: userID,
		ProductID:      body.ProductID,
		TimeSpan:       body.TimeSpan,
		TimeUnit:       body.TimeUnit,
	}
	req.DefaultPeriod()
	if !s.ensureOnlineProduct(w, r, req.ProductID) {
		return
	}
	out, err := s.trade.Inquiry(r.Context(), req)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) order(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	var body userOrderRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	req := tradeclient.OrderRequest{
		ExternalUserID: userID,
		ProductID:      body.ProductID,
		TimeSpan:       body.TimeSpan,
		TimeUnit:       body.TimeUnit,
	}
	req.DefaultPeriod()
	if !s.ensureOnlineProduct(w, r, req.ProductID) {
		return
	}
	out, err := s.trade.PlaceOrder(r.Context(), req)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	if out == nil || strings.TrimSpace(out.DealName) == "" {
		writeError(w, http.StatusBadGateway, "trade returned empty deal_name")
		return
	}
	response := userOrderResponse{BigOrderID: out.BigOrderID, DealName: out.DealName}
	if s.auth != nil {
		issueCtx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		response.AuthCode, err = s.auth.Issue(issueCtx, &authcode.Ticket{
			UserID:   userID,
			DealName: out.DealName,
		})
		cancel()
		if err != nil {
			log.Printf("credit order: issue auth_code failed: %v", err)
			response.AuthCode = ""
		}
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) orderAndPay(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	var body userOrderRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	req := tradeclient.OrderRequest{
		ExternalUserID: userID,
		ProductID:      body.ProductID,
		TimeSpan:       body.TimeSpan,
		TimeUnit:       body.TimeUnit,
	}
	req.DefaultPeriod()
	if !s.ensureOnlineProduct(w, r, req.ProductID) {
		return
	}
	out, err := s.trade.PlaceOrderAndPay(r.Context(), req)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) orderURL(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var body userOrderURLRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	dealName := strings.TrimSpace(body.DealName)
	if dealName == "" {
		writeError(w, http.StatusBadRequest, "deal_name is required")
		return
	}
	userID, ok := s.resolveOrderURLUserID(w, r, body.AuthCode, dealName)
	if !ok {
		return
	}
	result, err := s.trade.GeneratePayURL(r.Context(), dealName, tradeclient.PayURLRequest{
		ExternalUserID: userID,
		Platform:       body.Platform,
		WxOpenID:       body.WxOpenID,
		WxAppID:        paymentWxAppID(body.WxOpenID),
		CancelURL:      body.CancelURL,
		ReturnURL:      body.ReturnURL,
	})
	if err != nil {
		var tradeErr *tradeclient.Error
		if errors.As(err, &tradeErr) && tradeErr.Status == http.StatusNotFound {
			writeError(w, http.StatusNotFound, "order not found")
			return
		}
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	if result == nil {
		writeError(w, http.StatusBadGateway, "trade returned empty payment result")
		return
	}
	writeJSON(w, http.StatusOK, userOrderURLResponse{
		DealName:   dealName,
		PayURL:     result.PayURL,
		TokenID:    result.TokenID,
		OrderID:    result.OrderID,
		MidasAppID: result.MidasAppID,
		NeedCharge: result.NeedCharge,
		Uin:        result.Uin,
		AppID:      result.AppID,
	})
}

func (s *Server) resolveOrderURLUserID(w http.ResponseWriter, r *http.Request, code, dealName string) (string, bool) {
	code = strings.TrimSpace(code)
	if code != "" {
		if s.auth == nil {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return "", false
		}
		ticket, err := s.auth.Consume(r.Context(), code)
		if err != nil {
			if errors.Is(err, authcode.ErrTicketNotFound) {
				writeError(w, http.StatusUnauthorized, "auth_code invalid or expired")
				return "", false
			}
			log.Printf("credit order URL: consume auth_code failed: %v", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return "", false
		}
		if ticket == nil || strings.TrimSpace(ticket.UserID) == "" {
			writeError(w, http.StatusUnauthorized, "auth_code invalid or expired")
			return "", false
		}
		if ticket.DealName != dealName {
			writeError(w, http.StatusForbidden, "auth_code deal_name mismatch")
			return "", false
		}
		return ticket.UserID, true
	}

	if userID := strings.TrimSpace(r.Header.Get("X-User-Id")); userID != "" {
		return userID, true
	}
	writeError(w, http.StatusUnauthorized, "unauthorized")
	return "", false
}

func paymentWxAppID(wxOpenID string) string {
	if strings.TrimSpace(wxOpenID) == "" {
		return ""
	}
	return wechatPaymentAppID
}

func (s *Server) userCredits(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	credits, err := s.svc.QueryCredits(r.Context(), userID)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"credits": credits})
}

func (s *Server) userPackageAction(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/v1/credit/packages/")
	parts := strings.Split(strings.Trim(rest, "/"), "/")
	if len(parts) != 2 {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	packageID := strings.TrimSpace(parts[0])
	action := strings.TrimSpace(parts[1])
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	pkg, err := s.store.GetPackageByID(r.Context(), packageID)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	switch action {
	case "refund":
		s.userRefundPackage(w, r, pkg, userID)
	default:
		writeError(w, http.StatusNotFound, "not found")
	}
}

func (s *Server) userRefundPackage(w http.ResponseWriter, r *http.Request, pkg *store.CreditPackage, userID string) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if strings.TrimSpace(pkg.UserID) != strings.TrimSpace(userID) {
		writeError(w, http.StatusForbidden, "credit package does not belong to current user")
		return
	}
	s.refundPackage(w, r, pkg)
}

func (s *Server) refundPackage(w http.ResponseWriter, r *http.Request, pkg *store.CreditPackage) {
	out, err := s.trade.RefundPackage(r.Context(), pkg.PackageID, tradeclient.RefundRequest{
		OwnerUin:  pkg.Uin,
		UIN:       pkg.Uin,
		AppID:     pkg.AppID,
		ProductID: pkg.ProductID,
	})
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) adminPackages(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	page, ok := positiveQueryInt(w, r, "page", 1, 0)
	if !ok {
		return
	}
	pageSize, ok := positiveQueryInt(w, r, "page_size", 20, 100)
	if !ok {
		return
	}
	filter := store.AdminPackageFilter{
		UserID:    r.URL.Query().Get("user_id"),
		PackageID: r.URL.Query().Get("package_id"),
		ProductID: r.URL.Query().Get("product_id"),
		Status:    r.URL.Query().Get("status"),
		Page:      page,
		PageSize:  pageSize,
	}
	packages, total, err := s.store.ListAdminPackages(r.Context(), filter)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]any{
			"packages":  packages,
			"total":     total,
			"page":      page,
			"page_size": pageSize,
		},
	})
}

func (s *Server) adminPackageAction(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/internal/credit/admin/packages/")
	parts := strings.Split(strings.Trim(rest, "/"), "/")
	if len(parts) != 2 || strings.TrimSpace(parts[1]) != "refund" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	pkg, err := s.store.GetPackageByID(r.Context(), strings.TrimSpace(parts[0]))
	if errors.Is(err, store.ErrPackageNotFound) {
		writeError(w, http.StatusNotFound, "credit package not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if pkg.Status != store.PackageStatusActive {
		writeError(w, http.StatusConflict, "only active credit packages can be refunded")
		return
	}
	s.refundPackage(w, r, pkg)
}

func positiveQueryInt(w http.ResponseWriter, r *http.Request, name string, defaultValue, maxValue int) (int, bool) {
	raw := strings.TrimSpace(r.URL.Query().Get(name))
	if raw == "" {
		return defaultValue, true
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 || (maxValue > 0 && value > maxValue) {
		writeError(w, http.StatusBadRequest, name+" is invalid")
		return 0, false
	}
	return value, true
}

func (s *Server) internalProduct(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	productID := strings.TrimPrefix(r.URL.Path, "/internal/credit/products/")
	product, err := s.store.GetProductByID(r.Context(), productID)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "data": product})
}

func (s *Server) ensureOnlineProduct(w http.ResponseWriter, r *http.Request, productID string) bool {
	product, err := s.store.GetProductByID(r.Context(), strings.TrimSpace(productID))
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return false
	}
	if product.State != store.ProductStateOnline {
		writeError(w, http.StatusConflict, "credit product is offline")
		return false
	}
	return true
}

func (s *Server) internalComplete(w http.ResponseWriter, r *http.Request) {
	var req struct {
		DealName   string `json:"deal_name"`
		BigOrderID string `json:"big_order_id"`
		UserID     string `json:"user_id"`
		ProductID  string `json:"product_id"`
		Uin        string `json:"uin"`
		AppID      int64  `json:"app_id"`
		TimeSpan   int    `json:"time_span"`
		TimeUnit   string `json:"time_unit"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	pkg, err := s.svc.CompletePaidPackage(r.Context(), service.CompletePaidPackageRequest{
		DealName: req.DealName, BigOrderID: req.BigOrderID, UserID: req.UserID,
		ProductID: req.ProductID, Uin: req.Uin, AppID: req.AppID,
		TimeSpan: req.TimeSpan, TimeUnit: req.TimeUnit,
	})
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "data": pkg})
}

func (s *Server) internalUsedAmount(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Uin         string   `json:"uin"`
		AppID       int64    `json:"app_id"`
		ResourceIDs []string `json:"resource_ids"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	items, err := s.svc.GetUsedAmounts(r.Context(), service.UsedAmountRequest{
		Uin: req.Uin, AppID: req.AppID, ResourceIDs: req.ResourceIDs,
	})
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "data": items})
}

func (s *Server) internalResourceAppIDs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req struct {
		ProductIDs []string `json:"product_ids"`
		PageNo     int      `json:"page_no"`
		PageSize   int      `json:"page_size"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	appIDs, total, err := s.svc.ListResourceAppIDs(r.Context(), service.ResourcePageRequest{
		ProductIDs: req.ProductIDs, PageNo: req.PageNo, PageSize: req.PageSize,
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data":    map[string]any{"app_ids": appIDs, "total": total},
	})
}

func (s *Server) internalUserResources(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req struct {
		Uin        string   `json:"uin"`
		AppID      int64    `json:"app_id"`
		ProductIDs []string `json:"product_ids"`
		PageNo     int      `json:"page_no"`
		PageSize   int      `json:"page_size"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	items, total, err := s.svc.ListUserResources(r.Context(), service.UserResourcePageRequest{
		Uin: req.Uin, AppID: req.AppID, ProductIDs: req.ProductIDs, PageNo: req.PageNo, PageSize: req.PageSize,
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data":    map[string]any{"resources": items, "total": total},
	})
}

func (s *Server) internalQueryResources(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req struct {
		Uin         string   `json:"uin"`
		AppID       int64    `json:"app_id"`
		ResourceIDs []string `json:"resource_ids"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	items, err := s.svc.QueryResources(r.Context(), service.ResourceQueryRequest{
		Uin: req.Uin, AppID: req.AppID, ResourceIDs: req.ResourceIDs,
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "data": items})
}

func (s *Server) internalPackageAction(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/internal/credit/packages/")
	parts := strings.Split(strings.Trim(rest, "/"), "/")
	if len(parts) != 2 {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	packageID, action := parts[0], parts[1]
	switch action {
	case "isolate":
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		var req struct {
			Reason string `json:"reason"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		if err := s.svc.IsolatePaidPackage(r.Context(), packageID, req.Reason); err != nil {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
	default:
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "data": map[string]string{"status": "ok"}})
}

func (s *Server) requireInternal(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.token != "" && strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ") != s.token {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		next(w, r)
	}
}

func (s *Server) requireConfiguredInternal(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.token == "" {
			writeError(w, http.StatusServiceUnavailable, "internal token is not configured")
			return
		}
		if strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ") != s.token {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		next(w, r)
	}
}

func requireUserID(w http.ResponseWriter, r *http.Request) (string, bool) {
	userID := strings.TrimSpace(r.Header.Get("X-User-Id"))
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return "", false
	}
	return userID, true
}

func decodeJSON(w http.ResponseWriter, r *http.Request, out any) bool {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return false
	}
	if err := json.NewDecoder(r.Body).Decode(out); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return false
	}
	return true
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{"success": false, "message": message, "code": strconv.Itoa(status)})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
