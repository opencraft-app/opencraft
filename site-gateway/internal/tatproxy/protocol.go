package tatproxy

import "regexp"

const (
	remoteIP   = "127.0.0.1"
	remotePort = "3080"
)

var (
	regionPattern     = regexp.MustCompile(`^[a-z][a-z0-9-]{1,31}$`)
	instanceIDPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{2,127}$`)
)

func validRegion(region string) bool {
	return regionPattern.MatchString(region)
}

func validInstanceID(instanceID string) bool {
	return instanceIDPattern.MatchString(instanceID)
}

type frame struct {
	Type string   `json:"Type" bson:"Type"`
	Data envelope `json:"Data" bson:"Data"`
}

type envelope struct {
	SessionID  string  `json:"SessionId,omitempty" bson:"SessionId,omitempty"`
	ChannelID  string  `json:"ChannelId,omitempty" bson:"ChannelId,omitempty"`
	CustomData string  `json:"CustomData,omitempty" bson:"CustomData,omitempty"`
	Message    string  `json:"Message,omitempty" bson:"Message,omitempty"`
	ErrMsg     string  `json:"ErrMsg,omitempty" bson:"ErrMsg,omitempty"`
	Error      string  `json:"Error,omitempty" bson:"Error,omitempty"`
	Data       payload `json:"Data,omitempty" bson:"Data,omitempty"`
}

type payload struct {
	ProxyID string `json:"ProxyId,omitempty" bson:"ProxyId,omitempty"`
	IP      string `json:"Ip,omitempty" bson:"Ip,omitempty"`
	Port    string `json:"Port,omitempty" bson:"Port,omitempty"`
	Data    []byte `json:"Data,omitempty" bson:"Data,omitempty"`
	Error   string `json:"Error,omitempty" bson:"Error,omitempty"`
}

func frameError(f frame) string {
	for _, message := range []string{f.Data.Data.Error, f.Data.Error, f.Data.ErrMsg, f.Data.Message} {
		if message != "" {
			return message
		}
	}
	return ""
}
