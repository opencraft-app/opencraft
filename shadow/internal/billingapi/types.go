package billingapi

type GoodsInfo struct {
	GoodsCategoryID int64  `json:"GoodsCategoryId"`
	Zone            string `json:"Zone,omitempty"`
	GoodsNum        int64  `json:"GoodsNum"`
	ProjectID       int64  `json:"ProjectId,omitempty"`
	Region          string `json:"Region,omitempty"`
	PayMode         string `json:"PayMode"`
	GoodsDetail     string `json:"GoodsDetail"`
}

type CreateOrdersRequest struct {
	Goods       []GoodsInfo `json:"Goods"`
	AutoVoucher bool        `json:"AutoVoucher,omitempty"`
	ClientToken string      `json:"ClientToken,omitempty"`
}

type CreateOrdersResponse struct {
	OrderIds   []string `json:"OrderIds"`
	BigOrderId string   `json:"BigOrderId"`
	QywxToken  string   `json:"QywxToken"`
	RequestId  string   `json:"RequestId"`
}

type CreateOrdersAPIResponse struct {
	Response CreateOrdersResponse `json:"Response"`
}

type CreatePayURLRequest struct {
	OrderIds      []string `json:"OrderIds"`
	Platform      string   `json:"Platform,omitempty"`
	ContractOrder int      `json:"ContractOrder,omitempty"`
	CancelUrl     string   `json:"CancelUrl,omitempty"`
	ReturnUrl     string   `json:"ReturnUrl,omitempty"`
	PayScene      string   `json:"PayScene,omitempty"`
	Application   string   `json:"Application,omitempty"`
}

type CreatePayURLResponse struct {
	Url        string `json:"Url"`
	AppId      string `json:"AppId"`
	NeedCharge int    `json:"NeedCharge"`
	TokenId    string `json:"TokenId"`
	BillId     string `json:"BillId"`
	OpenId     string `json:"OpenId"`
	RequestId  string `json:"RequestId"`
}

type CreatePayURLAPIResponse struct {
	Response CreatePayURLResponse `json:"Response"`
}

type DescribeDealsByCondRequest struct {
	StartTime string `json:"StartTime"`
	EndTime   string `json:"EndTime"`
	Limit     int    `json:"Limit"`
	Offset    int    `json:"Offset,omitempty"`
	OrderId   string `json:"OrderId,omitempty"`
	BigDealId string `json:"BigDealId,omitempty"`
	StatusSet []int  `json:"StatusSet,omitempty"`
}

type Deal struct {
	OrderID     string   `json:"order_id"`
	BigDealID   string   `json:"big_deal_id"`
	Status      int      `json:"status"`
	PayMode     string   `json:"pay_mode"`
	ProductCode string   `json:"product_code"`
	ResourceIDs []string `json:"resource_ids"`
}

type DescribeDealsByCondResponse struct {
	Deals      []Deal `json:"deals"`
	TotalCount int    `json:"total_count"`
	RequestID  string `json:"request_id"`
}
