package tencentim

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"

	tencentimport "chatserver/internal/ports/tencentim"

	"github.com/google/uuid"
)

const sendMessagePath = "/v4/openim/sendmsg"

// RESTAgentNotificationSender sends a Tencent IM C2C TIMCustomElem from the
// configured App administrator. It intentionally does not send business text.
type RESTAgentNotificationSender struct {
	config RESTConfig
	base   *url.URL
}

func NewRESTAgentNotificationSender(
	config RESTConfig,
) (*RESTAgentNotificationSender, error) {
	base, err := validateRESTConfig(config)
	if err != nil {
		return nil, err
	}
	config.HTTPClient = redirectSafeHTTPClient(config.HTTPClient)
	return &RESTAgentNotificationSender{config: config, base: base}, nil
}

func (client *RESTAgentNotificationSender) SendAgentNotification(
	ctx context.Context,
	notification tencentimport.AgentNotification,
) error {
	customType, ok := notificationCustomType(notification.Type)
	if client == nil || ctx == nil || !ok ||
		!imUserIDPattern.MatchString(notification.ToUserID) ||
		!notificationUUIDv7(notification.ServerID) ||
		!notificationUUIDv7(notification.AgentID) ||
		!notificationUUIDv7(notification.ResourceID) ||
		!notificationUUIDv7(notification.EventID) || notification.Revision < 1 {
		return newRESTError("tencent_invalid_agent_notification", false)
	}
	payload, err := json.Marshal(struct {
		Schema     string `json:"schema"`
		Type       string `json:"type"`
		ServerID   string `json:"serverId"`
		AgentID    string `json:"agentId"`
		ResourceID string `json:"resourceId"`
		Revision   int64  `json:"revision"`
		EventID    string `json:"eventId"`
	}{
		Schema: "chatserver.agent-notification/v1",
		Type:   notification.Type, ServerID: notification.ServerID,
		AgentID: notification.AgentID, ResourceID: notification.ResourceID,
		Revision: notification.Revision, EventID: notification.EventID,
	})
	if err != nil || len(payload) > 8*1024 {
		return newRESTError("tencent_agent_notification_encode_failed", false)
	}
	messageDigest := sha256.Sum256([]byte(
		"chatserver-agent-notification-v1\x00" + notification.EventID,
	))
	messageSequence := binary.BigEndian.Uint32(messageDigest[0:4])
	if messageSequence == 0 {
		messageSequence = 1
	}
	messageRandom := binary.BigEndian.Uint32(messageDigest[4:8])
	if messageRandom == 0 {
		messageRandom = 1
	}
	body := struct {
		SyncOtherMachine int      `json:"SyncOtherMachine"`
		ToAccount        string   `json:"To_Account"`
		MsgSeq           uint32   `json:"MsgSeq"`
		MsgRandom        uint32   `json:"MsgRandom"`
		SendMsgControl   []string `json:"SendMsgControl"`
		MsgBody          []struct {
			MsgType    string `json:"MsgType"`
			MsgContent struct {
				Data string `json:"Data"`
				Desc string `json:"Desc"`
			} `json:"MsgContent"`
		} `json:"MsgBody"`
	}{
		SyncOtherMachine: 2,
		ToAccount:        notification.ToUserID,
		MsgSeq:           messageSequence, MsgRandom: messageRandom,
		SendMsgControl: []string{"NoUnread", "NoLastMsg"},
		MsgBody: make([]struct {
			MsgType    string `json:"MsgType"`
			MsgContent struct {
				Data string `json:"Data"`
				Desc string `json:"Desc"`
			} `json:"MsgContent"`
		}, 1),
	}
	body.MsgBody[0].MsgType = "TIMCustomElem"
	body.MsgBody[0].MsgContent.Data = string(payload)
	body.MsgBody[0].MsgContent.Desc = customType

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
	endpoint.Path += sendMessagePath
	query := endpoint.Query()
	query.Set("sdkappid", strconv.Itoa(client.config.SDKAppID))
	query.Set("identifier", client.config.AdminUserID)
	query.Set("usersig", adminSig.Value)
	query.Set("random", strconv.FormatUint(
		uint64(binary.BigEndian.Uint32(randomBytes)), 10,
	))
	query.Set("contenttype", "json")
	endpoint.RawQuery = query.Encode()
	var encoded bytes.Buffer
	if err := json.NewEncoder(&encoded).Encode(body); err != nil {
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
		return newRESTError(
			"tencent_http_"+strconv.Itoa(response.StatusCode),
			response.StatusCode == http.StatusTooManyRequests ||
				response.StatusCode >= 500,
		)
	}
	var result struct {
		ActionStatus string `json:"ActionStatus"`
		ErrorCode    int    `json:"ErrorCode"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, maxResponseBytes)).Decode(&result); err != nil {
		return newRESTError("tencent_response_invalid", true)
	}
	if result.ActionStatus == "OK" && result.ErrorCode == 0 {
		return nil
	}
	return newRESTError(
		"tencent_"+strconv.Itoa(result.ErrorCode),
		retryableTencentCode(result.ErrorCode),
	)
}

func notificationCustomType(notificationType string) (string, bool) {
	switch notificationType {
	case "reminder.due":
		return "platform.reminder.v1", true
	case "task.assigned":
		return "platform.task.v1", true
	default:
		return "", false
	}
}

func notificationUUIDv7(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed != uuid.Nil && parsed.Version() == 7
}

var _ tencentimport.AgentNotificationSender = (*RESTAgentNotificationSender)(nil)
