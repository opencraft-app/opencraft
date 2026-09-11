package store

import (
	"errors"
	"time"
)

const (
	ProductStateOnline  = "ONLINE"
	ProductStateOffline = "OFFLINE"

	PackageStatusActive      = "active"
	PackageStatusIsolating   = "isolating"
	PackageStatusIsolated    = "isolated"
	PackageStatusTerminating = "terminating"
	PackageStatusDeleted     = "deleted"

	UsagePushStatusInit    = "init"
	UsagePushStatusPending = "pending"
	UsagePushStatusSuccess = "success"
	UsagePushStatusFailed  = "failed"
)

var (
	ErrProductNotFound = errors.New("credit product not found")
	ErrPackageNotFound = errors.New("credit package not found")
)

type CreditProduct struct {
	ID               int64     `json:"-"`
	ProductID        string    `json:"product_id"`
	ProductName      string    `json:"product_name"`
	LLMGatewayPlanID string    `json:"llm_gateway_plan_id"`
	State            string    `json:"state"`
	CreatedTime      time.Time `json:"created_time"`
	UpdatedTime      time.Time `json:"updated_time"`
}

type CreditPackage struct {
	ID                  int64      `json:"-"`
	PackageID           string     `json:"package_id"`
	UserID              string     `json:"user_id"`
	ProductID           string     `json:"product_id"`
	Uin                 string     `json:"uin"`
	AppID               int64      `json:"app_id"`
	DealName            string     `json:"deal_name"`
	BigOrderID          string     `json:"big_order_id"`
	LLMGatewayPlanID    string     `json:"llm_gateway_plan_id"`
	LLMSubscriptionID   string     `json:"llm_subscription_id"`
	LLMSubscriptionName string     `json:"llm_subscription_name"`
	CreatedTime         time.Time  `json:"created_time"`
	ExpiredTime         time.Time  `json:"expired_time"`
	IsolatedTime        *time.Time `json:"isolated_time,omitempty"`
	Status              string     `json:"status"`
	UpdatedTime         time.Time  `json:"updated_time"`
}

type HistoryCreditPackage struct {
	CreditPackage
	DeletedTime   time.Time `json:"deleted_time"`
	DestroyReason string    `json:"destroy_reason"`
}

type CreditPackageUsage struct {
	ID                 int64
	PackageID          string
	UserID             string
	ProductID          string
	DealName           string
	Uin                string
	AppID              int64
	UsageDate          time.Time
	CalcDate           time.Time
	PackageExpiredTime time.Time
	CreditTotal        CreditAmount
	CreditUsedTotal    CreditAmount
	CreditUsedDay      CreditAmount
	CreditLeft         CreditAmount
	SnapshotTime       time.Time
	PushStatus         string
	PushAttempts       int
	NextRetryTime      time.Time
	LeaseOwner         string
	LastError          string
	RequestPayload     []byte
	ResponsePayload    []byte
	SentTime           *time.Time
	CreatedTime        time.Time
	UpdatedTime        time.Time
}

type UsageSnapshotUpdate struct {
	UsageDate       time.Time
	CalcDate        time.Time
	CreditTotal     CreditAmount
	CreditUsedTotal CreditAmount
	CreditUsedDay   CreditAmount
	CreditLeft      CreditAmount
	SnapshotTime    time.Time
	RequestPayload  []byte
}
