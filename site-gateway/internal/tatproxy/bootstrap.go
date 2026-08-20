package tatproxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"

	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common"
	tchttp "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/http"
	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/profile"
)

const (
	accountService  = "account"
	accountVersion  = "2018-12-25"
	accountEndpoint = "account.tencentcloudapi.com"
	accountRegion   = "ap-guangzhou"
	tatService      = "tat"
	tatVersion      = "2020-10-28"
	tatEndpoint     = "tat.tencentcloudapi.com"
)

// Target identifies the Tencent instance that owns a DSH process. The tunnel
// destination itself is deliberately not configurable.
type Target struct {
	Region     string
	InstanceID string
}

func (t Target) Key() string {
	return t.Region + "/" + t.InstanceID
}

func (t Target) Validate() error {
	if !validRegion(t.Region) || !validInstanceID(t.InstanceID) {
		return errors.New("invalid Tencent target")
	}
	return nil
}

type Bootstrap struct {
	SessionID  string
	Region     string
	InstanceID string
	OwnerUIN   string
	AppID      int64
	WSURL      string
}

type Starter interface {
	Start(context.Context, Target) (Bootstrap, error)
}

type cloudCaller interface {
	Call(ctx context.Context, service, version, action, region, endpoint string, parameters map[string]any, response any) error
}

type sdkCaller struct {
	credential *common.Credential
}

func (c *sdkCaller) Call(ctx context.Context, service, version, action, region, endpoint string, parameters map[string]any, response any) error {
	req := tchttp.NewCommonRequest(service, version, action)
	req.SetContext(ctx)
	if len(parameters) > 0 {
		if err := req.SetActionParameters(parameters); err != nil {
			return fmt.Errorf("set %s parameters: %w", action, err)
		}
	}
	resp := tchttp.NewCommonResponse()
	clientProfile := profile.NewClientProfile()
	clientProfile.HttpProfile.Endpoint = endpoint
	client := common.NewCommonClient(c.credential, region, clientProfile)
	if err := client.Send(req, resp); err != nil {
		return err
	}
	if err := json.Unmarshal(resp.GetBody(), response); err != nil {
		return fmt.Errorf("decode %s response: %w", action, err)
	}
	return nil
}

type accountInfo struct {
	ownerUIN string
	appID    int64
}

type CloudStarter struct {
	caller cloudCaller

	accountMu sync.Mutex
	account   accountInfo
}

func NewCloudStarter(secretID, secretKey string) (*CloudStarter, error) {
	secretID = strings.TrimSpace(secretID)
	secretKey = strings.TrimSpace(secretKey)
	if secretID == "" || secretKey == "" {
		return nil, errors.New("Tencent credentials are required")
	}
	return &CloudStarter{caller: &sdkCaller{credential: common.NewCredential(secretID, secretKey)}}, nil
}

func (s *CloudStarter) Start(ctx context.Context, target Target) (Bootstrap, error) {
	if err := target.Validate(); err != nil {
		return Bootstrap{}, err
	}
	account, err := s.loadAccount(ctx)
	if err != nil {
		return Bootstrap{}, fmt.Errorf("describe Tencent account: %w", err)
	}
	var response struct {
		Response struct {
			SessionID string `json:"SessionId"`
		} `json:"Response"`
	}
	if err := s.caller.Call(ctx, tatService, tatVersion, "StartSession", target.Region, tatEndpoint, map[string]any{
		"InstanceId": target.InstanceID,
	}, &response); err != nil {
		return Bootstrap{}, fmt.Errorf("start TAT session: %w", err)
	}
	sessionID := strings.TrimSpace(response.Response.SessionID)
	if sessionID == "" {
		return Bootstrap{}, errors.New("TAT StartSession returned an empty session id")
	}
	return Bootstrap{
		SessionID:  sessionID,
		Region:     target.Region,
		InstanceID: target.InstanceID,
		OwnerUIN:   account.ownerUIN,
		AppID:      account.appID,
		WSURL:      fmt.Sprintf("wss://%s.forward.tat-tc.tencent.cn/ws", target.Region),
	}, nil
}

func (s *CloudStarter) loadAccount(ctx context.Context) (accountInfo, error) {
	s.accountMu.Lock()
	defer s.accountMu.Unlock()
	if s.account.ownerUIN != "" && s.account.appID != 0 {
		return s.account, nil
	}
	var response struct {
		Response struct {
			OwnerUIN int64 `json:"OwnerUin"`
			AppID    int64 `json:"AppId"`
		} `json:"Response"`
	}
	if err := s.caller.Call(ctx, accountService, accountVersion, "DescribeAccountInfo", accountRegion, accountEndpoint, nil, &response); err != nil {
		return accountInfo{}, err
	}
	if response.Response.OwnerUIN == 0 || response.Response.AppID == 0 {
		return accountInfo{}, errors.New("DescribeAccountInfo returned incomplete account data")
	}
	s.account = accountInfo{
		ownerUIN: strconv.FormatInt(response.Response.OwnerUIN, 10),
		appID:    response.Response.AppID,
	}
	return s.account, nil
}
