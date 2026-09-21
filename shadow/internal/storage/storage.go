package storage

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"time"
)

var ErrNotFound = errors.New("record not found")
var ErrConflict = errors.New("record conflict")

type User struct {
	ID                       string    `json:"id"`
	CountryCode              string    `json:"country_code"`
	PhoneNumber              string    `json:"phone_number"`
	IsRegisterShadowAccount  bool      `json:"is_register_shadow_account"`
	IsShadowAccountBasicAuth bool      `json:"is_shadow_account_basic_auth"`
	IsStandardRealnameAuth   bool      `json:"is_standard_realname_auth"`
	CreatedAt                time.Time `json:"created_at"`
}

type Binding struct {
	UserID         string    `json:"user_id"`
	ShadowUserName string    `json:"shadow_user_name"`
	Uin            int64     `json:"uin"`
	OwnerUin       int64     `json:"owner_uin"`
	AppID          int64     `json:"appid"`
	InstanceID     string    `json:"instance_id"`
	CountryCode    string    `json:"country_code"`
	PhoneNumber    string    `json:"phone_number"`
	CreatedAt      time.Time `json:"created_at"`
}

type AuthCode struct {
	Code       string
	UserID     string
	ExpiresAt  time.Time
	ConsumedAt *time.Time
}

type FreeTrialOrderCheckpoint struct {
	UserID     string
	BigDealID  string
	DealName   string
	InstanceID string
	AppID      int64
	CreatedAt  time.Time
}

type PendingFreeTrialOrderStatus string

const (
	PendingFreeTrialOrderStatusOrdered PendingFreeTrialOrderStatus = "ordered"
	PendingFreeTrialOrderStatusPaid    PendingFreeTrialOrderStatus = "paid"
)

type PendingFreeTrialOrder struct {
	OwnerUin   int64
	UserID     string
	AppID      int64
	BigDealID  string
	DealName   string
	InstanceID string
	Status     PendingFreeTrialOrderStatus
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

type PackageProduct struct {
	Code                     string    `json:"code"`
	DisplayName              string    `json:"display_name"`
	CreditAmount             int64     `json:"credit_amount"`
	Currency                 string    `json:"currency"`
	BillingGoodsCategoryID   int64     `json:"billing_goods_category_id"`
	BillingRegion            string    `json:"billing_region"`
	BillingZone              string    `json:"billing_zone"`
	BillingPayMode           string    `json:"billing_pay_mode"`
	ProductCode              string    `json:"product_code"`
	SubProductCode           string    `json:"sub_product_code"`
	BillingItemTypeCode      string    `json:"billing_item_type_code"`
	BillingItemCode          string    `json:"billing_item_code"`
	BillingPID               int64     `json:"billing_pid"`
	BillingTimeUnit          string    `json:"billing_time_unit"`
	BillingTimeSpan          int64     `json:"billing_time_span"`
	BillingAction            string    `json:"billing_action"`
	BillingExtraParamsJSON   string    `json:"billing_extra_params_json"`
	BillingGoodsDetailJSON   string    `json:"billing_goods_detail_json"`
	RequiresStandardRealname bool      `json:"requires_standard_realname"`
	Enabled                  bool      `json:"enabled"`
	MetadataJSON             string    `json:"metadata_json"`
	CreatedAt                time.Time `json:"created_at"`
	UpdatedAt                time.Time `json:"updated_at"`
}

type PackageOrderStatus string

const (
	PackageOrderStatusCreated        PackageOrderStatus = "created"
	PackageOrderStatusPayURLReady    PackageOrderStatus = "pay_url_ready"
	PackageOrderStatusPaymentPending PackageOrderStatus = "payment_pending"
	PackageOrderStatusPaid           PackageOrderStatus = "paid"
	PackageOrderStatusCreditApplied  PackageOrderStatus = "credit_applied"
	PackageOrderStatusFailed         PackageOrderStatus = "failed"
	PackageOrderStatusCancelled      PackageOrderStatus = "cancelled"
)

type PackageOrder struct {
	ID                     string             `json:"id"`
	UserID                 string             `json:"user_id"`
	ProductCode            string             `json:"product_code"`
	Amount                 int64              `json:"amount"`
	Currency               string             `json:"currency"`
	Status                 PackageOrderStatus `json:"status"`
	BillingBigOrderID      string             `json:"billing_big_order_id"`
	BillingOrderIDs        []string           `json:"billing_order_ids"`
	PayURL                 string             `json:"pay_url"`
	NeedCharge             bool               `json:"need_charge"`
	ClientToken            string             `json:"client_token"`
	PaymentConfirmationKey string             `json:"payment_confirmation_key"`
	BillingRequestJSON     string             `json:"billing_request_json"`
	BillingResponseJSON    string             `json:"billing_response_json"`
	PaidAt                 *time.Time         `json:"paid_at"`
	CancelledAt            *time.Time         `json:"cancelled_at"`
	CreatedAt              time.Time          `json:"created_at"`
	UpdatedAt              time.Time          `json:"updated_at"`
}

type WalletAccount struct {
	UserID          string    `json:"user_id"`
	AvailableAmount int64     `json:"available_amount"`
	FrozenAmount    int64     `json:"frozen_amount"`
	Currency        string    `json:"currency"`
	Version         int64     `json:"version"`
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
}

type WalletLedgerEntry struct {
	ID               string    `json:"id"`
	UserID           string    `json:"user_id"`
	OrderID          string    `json:"order_id"`
	Type             string    `json:"type"`
	AmountDelta      int64     `json:"amount_delta"`
	BeforeBalance    int64     `json:"before_balance"`
	AfterBalance     int64     `json:"after_balance"`
	Reason           string    `json:"reason"`
	ExternalRefsJSON string    `json:"external_refs_json"`
	IdempotencyKey   string    `json:"idempotency_key"`
	CreatedAt        time.Time `json:"created_at"`
}

type WalletCreditResult struct {
	Order  PackageOrder
	Wallet WalletAccount
	Ledger WalletLedgerEntry
}

type Store interface {
	EnsureUser(ctx context.Context, userID, countryCode, phoneNumber string) (User, bool, error)
	GetUserByID(ctx context.Context, id string) (User, error)
	MarkShadowAccountRegistered(ctx context.Context, userID string) error
	MarkShadowAccountBasicAuth(ctx context.Context, userID string) error
	MarkStandardRealnameAuth(ctx context.Context, userID string) error
	UpdateUserPhone(ctx context.Context, userID, countryCode, phoneNumber string) error
	SaveBinding(ctx context.Context, binding Binding) error
	GetBindingByUserID(ctx context.Context, userID string) (Binding, error)
	SaveAppPhoneBinding(ctx context.Context, appID int64, countryCode, phoneNumber string) error
	SaveFreeTrialOrderCheckpoint(ctx context.Context, checkpoint FreeTrialOrderCheckpoint) error
	GetFreeTrialOrderCheckpointByUserID(ctx context.Context, userID string) (FreeTrialOrderCheckpoint, error)
	SavePendingFreeTrialOrder(ctx context.Context, order PendingFreeTrialOrder) error
	GetPendingFreeTrialOrderByOwnerUin(ctx context.Context, ownerUin int64) (PendingFreeTrialOrder, error)
	DeletePendingFreeTrialOrderByOwnerUin(ctx context.Context, ownerUin int64) error
	IssueAuthCode(ctx context.Context, userID string, ttl time.Duration) (AuthCode, error)
	ConsumeAuthCode(ctx context.Context, code string) (AuthCode, error)
	UpsertPackageProduct(ctx context.Context, product PackageProduct) error
	ListPackageProducts(ctx context.Context) ([]PackageProduct, error)
	GetPackageProductByCode(ctx context.Context, code string) (PackageProduct, error)
	CreatePackageOrder(ctx context.Context, order PackageOrder) error
	UpdatePackageOrderLaunch(ctx context.Context, orderID string, status PackageOrderStatus, bigOrderID string, orderIDs []string, payURL string, needCharge bool, requestJSON, responseJSON string) error
	GetPackageOrderByID(ctx context.Context, id string) (PackageOrder, error)
	ApplyPackageOrderCredit(ctx context.Context, orderID string, paidAt time.Time, externalRefsJSON string, amount int64, reason string) (WalletCreditResult, error)
	GetWalletAccountByUserID(ctx context.Context, userID string) (WalletAccount, error)
	Close() error
}

func PhoneKey(countryCode, phoneNumber string) string {
	return fmt.Sprintf("%s:%s", countryCode, phoneNumber)
}

func NewAuthCode() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw), nil
}
