package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"git.woa.com/wisp/mono/credit/internal/service"
	"git.woa.com/wisp/mono/credit/internal/store"
	"git.woa.com/wisp/mono/credit/internal/tradeclient"
)

type Server struct {
	svc   *service.Service
	store store.Store
	trade tradeService
	token string
}

type tradeService interface {
	Inquiry(context.Context, tradeclient.InquiryRequest) (map[string]any, error)
	PlaceOrder(context.Context, tradeclient.OrderRequest) (map[string]any, error)
	PlaceOrderAndPay(context.Context, tradeclient.OrderRequest) (map[string]any, error)
	RefundPackage(context.Context, string, tradeclient.RefundRequest) (map[string]any, error)
}

type userOrderRequest struct {
	ProductID string `json:"product_id"`
	TimeSpan  int    `json:"time_span"`
	TimeUnit  string `json:"time_unit"`
}

func NewRouter(svc *service.Service, st store.Store, trade tradeService, internalToken string) http.Handler {
	server := &Server{svc: svc, store: st, trade: trade, token: strings.TrimSpace(internalToken)}
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", server.health)
	mux.HandleFunc("/v1/credit/products", server.products)
	mux.HandleFunc("/v1/credit/inquiry", server.inquiry)
	mux.HandleFunc("/v1/credit/packages/order", server.order)
	mux.HandleFunc("/v1/credit/packages/order-and-pay", server.orderAndPay)
	mux.HandleFunc("/v1/credit/packages", server.userCredits)
	mux.HandleFunc("/v1/credit/packages/", server.userPackageAction)
	mux.HandleFunc("/internal/credit/products/", server.requireInternal(server.internalProduct))
	mux.HandleFunc("/internal/credit/packages/complete", server.requireInternal(server.internalComplete))
	mux.HandleFunc("/internal/credit/packages/used-amount", server.requireInternal(server.internalUsedAmount))
	mux.HandleFunc("/internal/credit/packages/app-ids", server.requireInternal(server.internalResourceAppIDs))
	mux.HandleFunc("/internal/credit/packages/by-owner", server.requireInternal(server.internalUserResources))
	mux.HandleFunc("/internal/credit/packages/query-resources", server.requireInternal(server.internalQueryResources))
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
	writeJSON(w, http.StatusOK, out)
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
