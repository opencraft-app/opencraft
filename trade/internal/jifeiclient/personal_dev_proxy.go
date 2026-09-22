package jifeiclient

import (
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// ResignPersonalDevModifyResourceStatusEnvelope validates the tenant boundary
// on a personal DevCloud request, removes any caller-provided billing auth, and
// signs the envelope with the central testing Trade credentials.
func ResignPersonalDevModifyResourceStatusEnvelope(
	body []byte,
	expectedUIN string,
	appID string,
	appSecret string,
	now time.Time,
	nonce string,
) ([]byte, error) {
	var env envelope
	if err := json.Unmarshal(body, &env); err != nil || env.Interface == nil {
		return nil, errors.New("invalid jifei billing envelope")
	}
	if env.Interface.InterfaceName != InterfaceNameModifyResourceStatus {
		return nil, errors.New("unsupported jifei billing interface")
	}
	expectedUIN = strings.TrimSpace(expectedUIN)
	if expectedUIN == "" || env.Interface.ExtraPara == nil || strings.TrimSpace(env.Interface.ExtraPara.OwnerUin) != expectedUIN {
		return nil, errors.New("jifei billing owner UIN mismatch")
	}
	var para struct {
		UIN string `json:"uin"`
	}
	if err := json.Unmarshal(env.Interface.Para, &para); err != nil || strings.TrimSpace(para.UIN) != expectedUIN {
		return nil, errors.New("jifei billing para UIN mismatch")
	}

	env.Interface.Auth = nil
	if now.IsZero() {
		now = time.Now().UTC()
	}
	if strings.TrimSpace(nonce) == "" {
		nonce = randomNonce()
	}
	auth, err := signBillingEnvelope(strings.TrimSpace(appID), strings.TrimSpace(appSecret), now.Unix(), nonce, env.Interface)
	if err != nil {
		return nil, err
	}
	env.Interface.Auth = auth
	return json.Marshal(env)
}
