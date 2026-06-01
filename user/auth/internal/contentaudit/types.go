package contentaudit

type CreateTextTaskRequest struct {
	ProductID string                    `json:"ProductID"`
	SID       string                    `json:"SID"`
	RequestID string                    `json:"RequestID"`
	Data      CreateTextTaskRequestData `json:"Data"`
}

type CreateImageTaskRequest struct {
	ProductID string                    `json:"ProductID"`
	SID       string                    `json:"SID"`
	RequestID string                    `json:"RequestID"`
	Data      CreateTextTaskRequestData `json:"Data"`
}

type CreateTextTaskRequestData struct {
	Comm    RequestComm    `json:"Comm"`
	ID      RequestID      `json:"ID"`
	Content RequestContent `json:"Content"`
}

type RequestComm struct {
	UlUin uint64 `json:"UlUin"`
	UiSeq uint32 `json:"UiSeq,omitempty"`
}

type RequestID struct {
	StrMsgID string `json:"StrMsgID"`
}

type RequestContent struct {
	User  RequestUser  `json:"User"`
	Msg   RequestMsg   `json:"Msg"`
	Media RequestMedia `json:"Media"`
}

type RequestUser struct {
	StrUin       string `json:"StrUin"`
	UiAcntType   uint32 `json:"UiAcntType"`
	StrHeadUrl   string `json:"StrHeadUrl,omitempty"`
	StrNick      string `json:"StrNick,omitempty"`
	StrDesc      string `json:"StrDesc,omitempty"`
	StrSignature string `json:"StrSignature,omitempty"`
}

type RequestMsg struct {
	UiPostTime uint64 `json:"UiPostTime"`
}

type RequestMedia struct {
	Text []RequestText `json:"Text,omitempty"`
	Pic  []RequestPic  `json:"Pic,omitempty"`
}

type RequestText struct {
	StrContent string `json:"StrContent"`
}

type RequestPic struct {
	StrContent string `json:"StrContent,omitempty"`
	StrURL     string `json:"StrURL,omitempty"`
}

type CreateTextTaskResponse struct {
	Response CreateTextTaskResponseBody `json:"Response"`
}

type CreateTextTaskResponseBody struct {
	RequestID string                      `json:"RequestID"`
	Data      *CreateTextTaskResponseData `json:"Data,omitempty"`
	Error     *ResponseError              `json:"Error,omitempty"`
}

type CreateTextTaskResponseData struct {
	Result          *ResponseResult `json:"Result,omitempty"`
	AhResultCode    int             `json:"AhResultCode,omitempty"`
	HasAsyncPending bool            `json:"HasAsyncPending,omitempty"`
}

type ResponseResult struct {
	ResultCode   uint   `json:"ResultCode"`
	ResultType   uint   `json:"ResultType"`
	ResultMsg    string `json:"ResultMsg,omitempty"`
	Operator     string `json:"Operator,omitempty"`
	UiTimeCostMs uint64 `json:"UiTimeCostMs,omitempty"`
	StdRetMsg    string `json:"StdRetMsg,omitempty"`
	StdRetCode   uint   `json:"StdRetCode,omitempty"`
}

type ResponseError struct {
	Code    string `json:"Code"`
	Message string `json:"Message"`
}

type CallbackRequest struct {
	Comm CallbackComm `json:"Comm"`
	Res  CallbackRes  `json:"Res"`
}

type CallbackComm struct {
	UiHitSource uint32 `json:"uiHitSource"`
}

type CallbackRes struct {
	UiResultCode uint32        `json:"uiResultCode"`
	UiResultType uint32        `json:"uiResultType"`
	StrResultMsg string        `json:"strResultMsg"`
	StrReasonMsg string        `json:"strReasonMsg"`
	ResID        CallbackResID `json:"ResID"`
}

type CallbackResID struct {
	StrMsgID string `json:"strMsgID"`
}
