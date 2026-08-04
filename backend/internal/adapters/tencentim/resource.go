package tencentim

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base32"
	"encoding/binary"
	"errors"
	"strings"

	"github.com/google/uuid"
)

const minimumResourceKeyBytes = 32

// ResourceDeriver 为平台资源派生稳定且不携带业务信息的腾讯 IM 标识。
type ResourceDeriver struct {
	key []byte
}

// NewResourceDeriver 创建腾讯 IM 资源标识派生器。
func NewResourceDeriver(key []byte) (*ResourceDeriver, error) {
	if len(key) < minimumResourceKeyBytes {
		return nil, errors.New("IM 资源派生密钥至少为 32 字节")
	}
	copied := make([]byte, len(key))
	copy(copied, key)
	return &ResourceDeriver{key: copied}, nil
}

// CommunityGroupID 按冻结规格生成自定义 Community GroupId。
func (deriver *ResourceDeriver) CommunityGroupID(
	serverID string,
) (string, error) {
	if deriver == nil {
		return "", errors.New("IM 资源派生器未配置")
	}
	parsed, err := uuid.Parse(serverID)
	if err != nil || parsed == uuid.Nil || parsed.Version() != 7 {
		return "", errors.New("Server ID 必须是 UUIDv7")
	}
	input := appendLengthPrefixed(nil, "community")
	input = appendLengthPrefixed(input, serverID)
	mac := hmac.New(sha256.New, deriver.key)
	_, _ = mac.Write(input)
	encoded := base32.StdEncoding.WithPadding(base32.NoPadding).
		EncodeToString(mac.Sum(nil))
	return "@TGS#_C_" + encoded[:26], nil
}

// Topic 按冻结规格生成 Community 下的自定义 TopicId 和安全 TopicName。
func (deriver *ResourceDeriver) Topic(
	serverID string,
	channelID string,
	groupID string,
) (string, string, error) {
	if deriver == nil {
		return "", "", errors.New("IM 资源派生器未配置")
	}
	parsedChannel, err := uuid.Parse(channelID)
	if err != nil || parsedChannel == uuid.Nil ||
		parsedChannel.Version() != 7 {
		return "", "", errors.New("Channel ID 必须是 UUIDv7")
	}
	expectedGroupID, err := deriver.CommunityGroupID(serverID)
	if err != nil {
		return "", "", err
	}
	if strings.TrimSpace(groupID) != expectedGroupID {
		return "", "", errors.New("Community GroupId 与 Server 不匹配")
	}
	input := appendLengthPrefixed(nil, "topic")
	input = appendLengthPrefixed(input, serverID)
	input = appendLengthPrefixed(input, channelID)
	mac := hmac.New(sha256.New, deriver.key)
	_, _ = mac.Write(input)
	encoded := base32.StdEncoding.WithPadding(base32.NoPadding).
		EncodeToString(mac.Sum(nil))
	return groupID + "@TOPIC#_T_" + encoded[:26],
		"C-" + encoded[:20],
		nil
}

// DirectGroupID 为一个 Server 内的 DirectConversation 派生无业务含义的 Work GroupId。
func (deriver *ResourceDeriver) DirectGroupID(
	serverID string,
	directConversationID string,
) (string, error) {
	if deriver == nil {
		return "", errors.New("IM 资源派生器未配置")
	}
	parsedServer, err := uuid.Parse(serverID)
	if err != nil || parsedServer == uuid.Nil || parsedServer.Version() != 7 {
		return "", errors.New("Server ID 必须是 UUIDv7")
	}
	parsedDirect, err := uuid.Parse(directConversationID)
	if err != nil || parsedDirect == uuid.Nil || parsedDirect.Version() != 7 {
		return "", errors.New("DirectConversation ID 必须是 UUIDv7")
	}
	input := appendLengthPrefixed(nil, "direct-conversation")
	input = appendLengthPrefixed(input, serverID)
	input = appendLengthPrefixed(input, directConversationID)
	mac := hmac.New(sha256.New, deriver.key)
	_, _ = mac.Write(input)
	encoded := base32.StdEncoding.WithPadding(base32.NoPadding).
		EncodeToString(mac.Sum(nil))
	return "an_dm_" + encoded[:26], nil
}

func appendLengthPrefixed(dst []byte, value string) []byte {
	offset := len(dst)
	dst = append(dst, 0, 0, 0, 0)
	binary.BigEndian.PutUint32(dst[offset:], uint32(len(value)))
	return append(dst, value...)
}
