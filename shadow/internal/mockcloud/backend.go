package mockcloud

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Account struct {
	ShadowUserName string
	Uin            int64
	OwnerUin       int64
	AppID          int64
	PhoneCountry   string
	PhoneNumber    string
	BasicAuthSaved bool
}

type order struct {
	BigDealID  string
	DealName   string
	InstanceID string
	Paid       bool
}

type Backend struct {
	mu          sync.Mutex
	platform    string
	callbackURL string
	httpClient  *http.Client

	nextUin int64
	nextSeq int64

	smsCodes        map[string]string
	accountsByUser  map[string]Account
	accountsByUin   map[int64]Account
	saasTokenToUser map[string]string
	ordersByOwner   map[int64]order
}

func NewBackend(platform string) *Backend {
	return &Backend{
		platform:        platform,
		httpClient:      &http.Client{Timeout: 5 * time.Second},
		nextUin:         300000000000,
		nextSeq:         1,
		smsCodes:        map[string]string{},
		accountsByUser:  map[string]Account{},
		accountsByUin:   map[int64]Account{},
		saasTokenToUser: map[string]string{},
		ordersByOwner:   map[int64]order{},
	}
}

func (b *Backend) SetCallbackURL(url string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.callbackURL = url
}

func (b *Backend) SMSCode(countryCode, phoneNumber string) (string, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	code, ok := b.smsCodes[phoneKey(countryCode, phoneNumber)]
	return code, ok
}

func (b *Backend) AccountByShadowUser(shadowUser string) (Account, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	account, ok := b.accountsByUser[shadowUser]
	if !ok && len(b.accountsByUser) == 1 {
		for _, candidate := range b.accountsByUser {
			account = candidate
			ok = true
		}
	}
	return account, ok
}

func (b *Backend) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /account/send-sms", b.handleSendSMS)
	mux.HandleFunc("POST /account/register", b.handleRegister)
	mux.HandleFunc("POST /account/get-appid", b.handleGetAppID)
	mux.HandleFunc("POST /account/save-basic-auth", b.handleSaveBasicAuth)
	mux.HandleFunc("POST /account/update-phone", b.handleUpdatePhone)
	mux.HandleFunc("POST /cam/token-by-auth-code", b.handleGetTokenByAuthCode)
	mux.HandleFunc("POST /sts/access-token", b.handleGetAccessToken)
	mux.HandleFunc("POST /dianshi/activity_web/activity/do_goods", b.handleDianshi)
	mux.HandleFunc("POST /billing/interfaces/interface.php", b.handleBilling)
	mux.HandleFunc("POST /recovery/free-trial", b.handleRecovery)
	return mux
}

func (b *Backend) handleSendSMS(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Platform    string `json:"platform"`
		CountryCode string `json:"country_code"`
		PhoneNumber string `json:"phone_number"`
	}
	if !decode(w, r, &req) {
		return
	}
	if err := b.ensurePlatform(req.Platform); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	code := "123456"
	b.mu.Lock()
	b.smsCodes[phoneKey(req.CountryCode, req.PhoneNumber)] = code
	b.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (b *Backend) handleRegister(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Platform        string `json:"platform"`
		CountryCode     string `json:"country_code"`
		PhoneNumber     string `json:"phone_number"`
		PhoneVerifyCode string `json:"phone_verify_code"`
		UserName        string `json:"user_name"`
	}
	if !decode(w, r, &req) {
		return
	}
	if err := b.ensurePlatform(req.Platform); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.smsCodes[phoneKey(req.CountryCode, req.PhoneNumber)] != req.PhoneVerifyCode {
		writeError(w, http.StatusBadRequest, errors.New("verify code mismatch"))
		return
	}
	if _, exists := b.accountsByUser[req.UserName]; exists {
		writeError(w, http.StatusConflict, errors.New("user already exists"))
		return
	}
	b.nextUin++
	uin := b.nextUin
	appID := uin%100000000 + 1000000000
	account := Account{
		ShadowUserName: req.UserName,
		Uin:            uin,
		OwnerUin:       uin,
		AppID:          appID,
		PhoneCountry:   req.CountryCode,
		PhoneNumber:    req.PhoneNumber,
	}
	b.accountsByUser[req.UserName] = account
	b.accountsByUin[uin] = account
	writeJSON(w, http.StatusOK, map[string]any{
		"uin":          uin,
		"key":          fmt.Sprintf("key-%d", uin),
		"expired_time": time.Now().Add(time.Hour).Unix(),
		"request_id":   fmt.Sprintf("req-register-%d", uin),
	})
}

func (b *Backend) handleGetAppID(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Uin int64 `json:"uin"`
	}
	if !decode(w, r, &req) {
		return
	}
	b.mu.Lock()
	account, ok := b.accountsByUin[req.Uin]
	b.mu.Unlock()
	if !ok {
		writeError(w, http.StatusNotFound, errors.New("uin not found"))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"appid": account.AppID})
}

func (b *Backend) handleSaveBasicAuth(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	if !decode(w, r, &req) {
		return
	}
	b.mu.Lock()
	account, ok := b.accountsByUser[req.Name]
	if ok {
		account.BasicAuthSaved = true
		b.accountsByUser[req.Name] = account
		b.accountsByUin[account.Uin] = account
	}
	b.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (b *Backend) handleGetTokenByAuthCode(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Platform string `json:"platform"`
		AuthCode string `json:"auth_code"`
	}
	if !decode(w, r, &req) {
		return
	}
	if err := b.ensurePlatform(req.Platform); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	shadowUser, err := b.checkAuthCode(r.Context(), req.AuthCode)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	b.mu.Lock()
	account, ok := b.accountsByUser[shadowUser]
	if !ok && len(b.accountsByUser) == 1 {
		for _, candidate := range b.accountsByUser {
			account = candidate
			ok = true
		}
	}
	if ok {
		b.saasTokenToUser["saas-token-"+req.AuthCode] = shadowUser
	}
	b.mu.Unlock()
	if !ok {
		writeError(w, http.StatusNotFound, errors.New("shadow user not found"))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"uin":          account.Uin,
		"owner_uin":    account.OwnerUin,
		"token":        "saas-token-" + req.AuthCode,
		"expired_time": time.Now().Add(time.Hour).Unix(),
		"request_id":   "req-cam-" + req.AuthCode,
	})
}

func (b *Backend) handleGetAccessToken(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Platform string `json:"platform"`
		Token    string `json:"token"`
	}
	if !decode(w, r, &req) {
		return
	}
	if err := b.ensurePlatform(req.Platform); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	b.mu.Lock()
	_, ok := b.saasTokenToUser[req.Token]
	b.mu.Unlock()
	if !ok {
		writeError(w, http.StatusUnauthorized, errors.New("invalid saas token"))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"token":          "tmp-token",
		"tmp_secret_id":  "tmp-secret-id",
		"tmp_secret_key": "tmp-secret-key",
		"expired_time":   time.Now().Add(time.Hour).Unix(),
		"request_id":     "req-sts",
	})
}

func (b *Backend) handleUpdatePhone(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Platform            string `json:"platform"`
		OldPhoneCountryCode string `json:"old_phone_country_code"`
		OldPhoneNumber      string `json:"old_phone_number"`
		NewPhoneCountryCode string `json:"new_phone_country_code"`
		NewPhoneNumber      string `json:"new_phone_number"`
		AuthCode            string `json:"auth_code"`
		VerifyCode          string `json:"verify_code"`
	}
	if !decode(w, r, &req) {
		return
	}
	if err := b.ensurePlatform(req.Platform); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if code, ok := b.SMSCode(req.NewPhoneCountryCode, req.NewPhoneNumber); !ok || code != req.VerifyCode {
		writeError(w, http.StatusBadRequest, errors.New("verify code mismatch"))
		return
	}
	shadowUser, err := b.checkAuthCode(r.Context(), req.AuthCode)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	account, ok := b.accountsByUser[shadowUser]
	if !ok && len(b.accountsByUser) == 1 {
		for _, candidate := range b.accountsByUser {
			account = candidate
			ok = true
		}
	}
	if !ok {
		writeError(w, http.StatusNotFound, errors.New("shadow user not found"))
		return
	}
	if account.PhoneCountry != req.OldPhoneCountryCode || account.PhoneNumber != req.OldPhoneNumber {
		writeError(w, http.StatusBadRequest, errors.New("old phone mismatch"))
		return
	}
	account.PhoneCountry = req.NewPhoneCountryCode
	account.PhoneNumber = req.NewPhoneNumber
	b.accountsByUser[account.ShadowUserName] = account
	b.accountsByUin[account.Uin] = account
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (b *Backend) handleDianshi(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Interface struct {
			Para struct {
				SaaSInfo struct {
					TokenOwnerUin int64 `json:"TokenOwnerUin"`
				} `json:"saas_info"`
			} `json:"para"`
		} `json:"interface"`
	}
	if !decode(w, r, &req) {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if existing, ok := b.ordersByOwner[req.Interface.Para.SaaSInfo.TokenOwnerUin]; ok {
		if existing.Paid {
			writeJSON(w, http.StatusOK, map[string]any{
				"returnCode":    1100106,
				"returnMessage": "duplicate order",
			})
			return
		}
	}
	seq := b.nextSeq
	b.nextSeq++
	bigDealID := "bigdeal-" + strconv.FormatInt(seq, 10)
	b.ordersByOwner[req.Interface.Para.SaaSInfo.TokenOwnerUin] = order{
		BigDealID: bigDealID,
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"returnCode":    0,
		"returnMessage": "ok",
		"data": map[string]any{
			"big_deal_no": bigDealID,
		},
	})
}

func (b *Backend) handleBilling(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Interface struct {
			InterfaceName string `json:"interfaceName"`
			Para          struct {
				OwnerUin   string   `json:"ownerUin"`
				BigDealIDs []string `json:"bigDealIds"`
			} `json:"para"`
		} `json:"interface"`
	}
	if !decode(w, r, &req) {
		return
	}
	if req.Interface.InterfaceName != "qcloud.Deal.payDealsNew" {
		writeJSON(w, http.StatusOK, map[string]any{
			"returnCode":    1,
			"returnMessage": "unsupported billing interface",
		})
		return
	}
	ownerUin, _ := strconv.ParseInt(req.Interface.Para.OwnerUin, 10, 64)
	b.mu.Lock()
	defer b.mu.Unlock()
	ord, ok := b.ordersByOwner[ownerUin]
	if !ok || len(req.Interface.Para.BigDealIDs) == 0 || ord.BigDealID != req.Interface.Para.BigDealIDs[0] {
		writeJSON(w, http.StatusOK, map[string]any{
			"returnCode":    100102,
			"returnMessage": "already paid",
			"data":          map[string]any{},
		})
		return
	}
	if ord.Paid {
		writeJSON(w, http.StatusOK, map[string]any{
			"returnCode":    100102,
			"returnMessage": "already paid",
			"data":          map[string]any{},
		})
		return
	}
	seq := b.nextSeq
	b.nextSeq++
	ord.Paid = true
	ord.DealName = "deal-" + strconv.FormatInt(seq, 10)
	ord.InstanceID = "ins-" + strconv.FormatInt(seq, 10)
	b.ordersByOwner[ownerUin] = ord
	writeJSON(w, http.StatusOK, map[string]any{
		"returnCode":    0,
		"returnMessage": "ok",
		"data": map[string]any{
			"dealNames": []string{ord.DealName},
			"resourceIds": map[string]any{
				ord.DealName: []string{ord.InstanceID},
			},
		},
	})
}

func (b *Backend) handleRecovery(w http.ResponseWriter, r *http.Request) {
	var req struct {
		BigDealID string `json:"big_deal_id"`
		OwnerUin  int64  `json:"owner_uin"`
		AppID     int64  `json:"app_id"`
	}
	if !decode(w, r, &req) {
		return
	}
	b.mu.Lock()
	ord, ok := b.ordersByOwner[req.OwnerUin]
	b.mu.Unlock()
	if !ok || ord.BigDealID != req.BigDealID || !ord.Paid {
		writeError(w, http.StatusNotFound, errors.New("order not found"))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"deal_name":   ord.DealName,
		"instance_id": ord.InstanceID,
	})
}

func (b *Backend) checkAuthCode(ctx context.Context, authCode string) (string, error) {
	b.mu.Lock()
	callbackURL := b.callbackURL
	b.mu.Unlock()
	if callbackURL == "" {
		return "", errors.New("callback url is not configured")
	}
	payload := map[string]any{
		"version":       "1.0",
		"caller":        "MOCKCLOUD",
		"componentName": "MOCKCLOUD",
		"eventId":       fmt.Sprintf("evt-%d", time.Now().UnixNano()),
		"timestamp":     time.Now().Unix(),
		"interface": map[string]any{
			"interfaceName": "qcloud.saas.checkSaaSAuthCode",
			"para": map[string]any{
				"auth_code": authCode,
			},
		},
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, callbackURL, bytes.NewReader(raw))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := b.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	var body struct {
		ReturnCode int `json:"returnCode"`
		Data       struct {
			UserID string `json:"user_id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return "", err
	}
	if body.ReturnCode != 0 || body.Data.UserID == "" {
		return "", errors.New("auth_code is invalid")
	}
	return body.Data.UserID, nil
}

func (b *Backend) ensurePlatform(v string) error {
	if strings.TrimSpace(v) != b.platform {
		return fmt.Errorf("unsupported platform %q", v)
	}
	return nil
}

func phoneKey(countryCode, phoneNumber string) string {
	return countryCode + ":" + phoneNumber
}

func decode(w http.ResponseWriter, r *http.Request, out any) bool {
	if err := json.NewDecoder(r.Body).Decode(out); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}
