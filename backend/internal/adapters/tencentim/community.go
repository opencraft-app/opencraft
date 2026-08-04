package tencentim

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf8"

	tencentimport "chatserver/internal/ports/tencentim"
)

const (
	createGroupPath  = "/v4/group_open_http_svc/create_group"
	getGroupInfoPath = "/v4/group_open_http_svc/get_group_info"
	createTopicPath  = "/v4/million_group_open_http_svc/create_topic"
	getTopicPath     = "/v4/million_group_open_http_svc/get_topic"
)

// RESTCommunityProvisioner 通过腾讯云 IM REST API 幂等确保 Community。
type RESTCommunityProvisioner struct {
	config RESTConfig
	base   *url.URL
}

// NewRESTCommunityProvisioner 创建 Community 适配器。
func NewRESTCommunityProvisioner(
	config RESTConfig,
) (*RESTCommunityProvisioner, error) {
	base, err := validateRESTConfig(config)
	if err != nil {
		return nil, err
	}
	config.HTTPClient = redirectSafeHTTPClient(config.HTTPClient)
	return &RESTCommunityProvisioner{config: config, base: base}, nil
}

// EnsureCommunity 创建 Community；GroupId 已存在时回查并校验稳定身份。
func (client *RESTCommunityProvisioner) EnsureCommunity(
	ctx context.Context,
	community tencentimport.Community,
) error {
	if client == nil || ctx == nil || !validCommunity(community) {
		return newRESTError("tencent_invalid_community", false)
	}

	request := struct {
		OwnerAccount     string `json:"Owner_Account"`
		Type             string `json:"Type"`
		GroupID          string `json:"GroupId"`
		Name             string `json:"Name"`
		Introduction     string `json:"Introduction,omitempty"`
		ApplyJoinOption  string `json:"ApplyJoinOption"`
		InviteJoinOption string `json:"InviteJoinOption"`
		SupportTopic     int    `json:"SupportTopic"`
		EnablePermission int    `json:"EnablePermission"`
	}{
		OwnerAccount:     community.OwnerUserID,
		Type:             "Community",
		GroupID:          community.GroupID,
		Name:             community.Name,
		Introduction:     community.Introduction,
		ApplyJoinOption:  "DisableApply",
		InviteJoinOption: "DisableInvite",
		SupportTopic:     1,
		EnablePermission: 0,
	}
	var response struct {
		ActionStatus string `json:"ActionStatus"`
		ErrorCode    int    `json:"ErrorCode"`
		GroupID      string `json:"GroupId"`
	}
	if err := client.postJSON(ctx, createGroupPath, request, &response); err != nil {
		return err
	}
	if response.ActionStatus == "OK" && response.ErrorCode == 0 {
		if response.GroupID != "" && response.GroupID != community.GroupID {
			return newRESTError("tencent_community_conflict", false)
		}
		return nil
	}
	if response.ErrorCode == 10021 || response.ErrorCode == 10025 {
		return client.reconcileCommunity(ctx, community)
	}
	return newRESTError(
		"tencent_"+strconv.Itoa(response.ErrorCode),
		retryableCommunityCode(response.ErrorCode),
	)
}

func (client *RESTCommunityProvisioner) reconcileCommunity(
	ctx context.Context,
	community tencentimport.Community,
) error {
	request := struct {
		GroupIDList    []string `json:"GroupIdList"`
		ResponseFilter struct {
			GroupBaseInfoFilter []string `json:"GroupBaseInfoFilter"`
		} `json:"ResponseFilter"`
	}{
		GroupIDList: []string{community.GroupID},
	}
	request.ResponseFilter.GroupBaseInfoFilter = []string{
		"Type",
		"Name",
		"Owner_Account",
	}

	var response struct {
		ActionStatus string `json:"ActionStatus"`
		ErrorCode    int    `json:"ErrorCode"`
		GroupInfo    []struct {
			GroupID      string `json:"GroupId"`
			Type         string `json:"Type"`
			OwnerAccount string `json:"Owner_Account"`
			ErrorCode    int    `json:"ErrorCode"`
		} `json:"GroupInfo"`
	}
	if err := client.postJSON(
		ctx,
		getGroupInfoPath,
		request,
		&response,
	); err != nil {
		return err
	}
	if response.ActionStatus != "OK" || response.ErrorCode != 0 {
		return newRESTError(
			"tencent_"+strconv.Itoa(response.ErrorCode),
			retryableCommunityCode(response.ErrorCode),
		)
	}
	if len(response.GroupInfo) != 1 {
		return newRESTError("tencent_community_reconcile_failed", true)
	}
	actual := response.GroupInfo[0]
	if actual.ErrorCode != 0 {
		return newRESTError(
			"tencent_"+strconv.Itoa(actual.ErrorCode),
			retryableCommunityCode(actual.ErrorCode),
		)
	}
	if actual.GroupID != community.GroupID ||
		actual.Type != "Community" ||
		actual.OwnerAccount != community.OwnerUserID {
		return newRESTError("tencent_community_conflict", false)
	}
	return nil
}

// EnsureTopic 创建 Topic；自定义 TopicId 已存在时回查稳定身份。
func (client *RESTCommunityProvisioner) EnsureTopic(
	ctx context.Context,
	topic tencentimport.Topic,
) error {
	if client == nil || ctx == nil || !validTopic(topic) {
		return newRESTError("tencent_invalid_topic", false)
	}
	topicType := "Public"
	applyJoinOption := ""
	inviteJoinOption := ""
	if topic.Private {
		topicType = "Private"
		applyJoinOption = "DisableApply"
		inviteJoinOption = "DisableInvite"
	}
	request := struct {
		GroupID          string `json:"GroupId"`
		TopicID          string `json:"TopicId"`
		TopicName        string `json:"TopicName"`
		FromAccount      string `json:"From_Account"`
		Introduction     string `json:"Introduction,omitempty"`
		TopicType        string `json:"TopicType"`
		ApplyJoinOption  string `json:"ApplyJoinOption,omitempty"`
		InviteJoinOption string `json:"InviteJoinOption,omitempty"`
	}{
		GroupID:          topic.GroupID,
		TopicID:          topic.TopicID,
		TopicName:        topic.TopicName,
		FromAccount:      topic.OwnerUserID,
		Introduction:     topic.Introduction,
		TopicType:        topicType,
		ApplyJoinOption:  applyJoinOption,
		InviteJoinOption: inviteJoinOption,
	}
	var response struct {
		ActionStatus string `json:"ActionStatus"`
		ErrorCode    int    `json:"ErrorCode"`
		TopicID      string `json:"TopicId"`
	}
	if err := client.postJSON(
		ctx,
		createTopicPath,
		request,
		&response,
	); err != nil {
		return err
	}
	if response.ActionStatus == "OK" && response.ErrorCode == 0 {
		if response.TopicID != topic.TopicID {
			return newRESTError("tencent_topic_conflict", false)
		}
		return nil
	}
	if response.ErrorCode == 10021 || response.ErrorCode == 10025 {
		return client.reconcileTopic(ctx, topic)
	}
	return newRESTError(
		"tencent_"+strconv.Itoa(response.ErrorCode),
		retryableTopicCode(response.ErrorCode),
	)
}

func (client *RESTCommunityProvisioner) reconcileTopic(
	ctx context.Context,
	topic tencentimport.Topic,
) error {
	request := struct {
		GroupID     string   `json:"GroupId"`
		FromAccount string   `json:"From_Account"`
		TopicIDs    []string `json:"TopicIdList"`
	}{
		GroupID:     topic.GroupID,
		FromAccount: topic.OwnerUserID,
		TopicIDs:    []string{topic.TopicID},
	}
	var response struct {
		ActionStatus string `json:"ActionStatus"`
		ErrorCode    int    `json:"ErrorCode"`
		Topics       []struct {
			ErrorCode int `json:"ErrorCode"`
			TopicInfo struct {
				GroupID      string `json:"GroupID"`
				TopicID      string `json:"TopicId"`
				TopicName    string `json:"TopicName"`
				Introduction string `json:"Introduction"`
				TopicType    string `json:"TopicType"`
			} `json:"TopicInfo"`
		} `json:"TopicAndSelfInfo"`
	}
	if err := client.postJSON(
		ctx,
		getTopicPath,
		request,
		&response,
	); err != nil {
		return err
	}
	if response.ActionStatus != "OK" ||
		response.ErrorCode != 0 ||
		len(response.Topics) != 1 {
		return newRESTError("tencent_topic_reconcile_failed", true)
	}
	actual := response.Topics[0]
	expectedType := "Public"
	if topic.Private {
		expectedType = "Private"
	}
	if actual.ErrorCode != 0 ||
		actual.TopicInfo.GroupID != topic.GroupID ||
		actual.TopicInfo.TopicID != topic.TopicID ||
		actual.TopicInfo.TopicName != topic.TopicName ||
		actual.TopicInfo.Introduction != topic.Introduction ||
		actual.TopicInfo.TopicType != expectedType {
		return newRESTError("tencent_topic_conflict", false)
	}
	return nil
}

func (client *RESTCommunityProvisioner) postJSON(
	ctx context.Context,
	path string,
	input any,
	output any,
) error {
	adminSig, err := client.config.AdminSignatures.Issue(
		ctx,
		client.config.AdminUserID,
		client.config.AdminSigTTL,
	)
	if err != nil {
		return newRESTError("tencent_admin_signature_failed", false)
	}
	randomBytes := make([]byte, 4)
	if _, err := io.ReadFull(client.config.Random, randomBytes); err != nil {
		return newRESTError("tencent_random_failed", false)
	}
	endpoint := *client.base
	endpoint.Path += path
	query := endpoint.Query()
	query.Set("sdkappid", strconv.Itoa(client.config.SDKAppID))
	query.Set("identifier", client.config.AdminUserID)
	query.Set("usersig", adminSig.Value)
	query.Set(
		"random",
		strconv.FormatUint(
			uint64(binary.BigEndian.Uint32(randomBytes)),
			10,
		),
	)
	query.Set("contenttype", "json")
	endpoint.RawQuery = query.Encode()

	var encoded bytes.Buffer
	if err := json.NewEncoder(&encoded).Encode(input); err != nil {
		return newRESTError("tencent_request_encode_failed", false)
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		endpoint.String(),
		&encoded,
	)
	if err != nil {
		return newRESTError("tencent_request_invalid", false)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	response, err := client.config.HTTPClient.Do(request)
	if err != nil {
		return newRESTError("tencent_network_error", true)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		retryable := response.StatusCode == http.StatusTooManyRequests ||
			response.StatusCode >= 500
		return newRESTError(
			"tencent_http_"+strconv.Itoa(response.StatusCode),
			retryable,
		)
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, maxResponseBytes))
	if err := decoder.Decode(output); err != nil {
		return newRESTError("tencent_response_invalid", true)
	}
	return nil
}

func validateRESTConfig(config RESTConfig) (*url.URL, error) {
	base, err := url.Parse(strings.TrimSpace(config.BaseURL))
	if err != nil ||
		base.Host == "" ||
		base.RawQuery != "" ||
		base.Fragment != "" ||
		base.User != nil ||
		!secureRESTScheme(base) ||
		config.SDKAppID <= 0 ||
		!imUserIDPattern.MatchString(config.AdminUserID) ||
		config.HTTPClient == nil ||
		config.Random == nil ||
		config.AdminSignatures == nil ||
		config.AdminSigTTL <= 0 {
		return nil, errors.New("腾讯云 IM REST 配置无效")
	}
	base.Path = strings.TrimRight(base.Path, "/")
	return base, nil
}

func redirectSafeHTTPClient(client *http.Client) *http.Client {
	copied := *client
	copied.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	return &copied
}

func validCommunity(community tencentimport.Community) bool {
	return strings.HasPrefix(community.GroupID, "@TGS#_C_") &&
		len(community.GroupID) <= 48 &&
		imUserIDPattern.MatchString(community.OwnerUserID) &&
		strings.TrimSpace(community.Name) != "" &&
		utf8.ValidString(community.Name) &&
		len(community.Name) <= 100 &&
		utf8.ValidString(community.Introduction) &&
		len(community.Introduction) <= 400
}

func validTopic(topic tencentimport.Topic) bool {
	return strings.HasPrefix(topic.GroupID, "@TGS#_C_") &&
		len(topic.GroupID) <= 48 &&
		strings.HasPrefix(topic.TopicID, topic.GroupID+"@TOPIC#_") &&
		len(topic.TopicID) <= 96 &&
		strings.TrimSpace(topic.TopicName) != "" &&
		utf8.ValidString(topic.TopicName) &&
		len(topic.TopicName) <= 30 &&
		imUserIDPattern.MatchString(topic.OwnerUserID) &&
		utf8.ValidString(topic.Introduction) &&
		len(topic.Introduction) <= 240
}

func retryableCommunityCode(code int) bool {
	switch code {
	case 10003, 10004, 10005, 10007, 10008, 10016,
		10021, 10036, 10037, 10038, 10058:
		return false
	case 10002, 10006:
		return true
	default:
		return retryableTencentCode(code)
	}
}

func retryableTopicCode(code int) bool {
	switch code {
	case 10003, 10004, 10007, 10008, 10010, 10015, 10016,
		10021, 10025, 10037, 11000, 11003, 80001:
		return false
	case 10002, 10006:
		return true
	default:
		return retryableTencentCode(code)
	}
}

var _ tencentimport.CommunityProvisioner = (*RESTCommunityProvisioner)(nil)
var _ tencentimport.TopicProvisioner = (*RESTCommunityProvisioner)(nil)
