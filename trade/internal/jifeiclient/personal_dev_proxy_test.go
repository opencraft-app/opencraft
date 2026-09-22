package jifeiclient

import (
	"encoding/json"
	"testing"
	"time"
)

func TestResignPersonalDevModifyResourceStatusEnvelopeReplacesCallerAuth(t *testing.T) {
	body := []byte(`{"version":"1.0","componentName":"lightvela","caller":"lightvela","eventId":1,"timestamp":2,"interface":{"interfaceName":"qcloud.operation.ModifyResourceStatus","extraPara":{"ownerUin":"450860000023"},"para":{"uin":"450860000023"},"auth":{"appid":"attacker","timestamp":"1","nonce":"x","signature":"bad"}}}`)
	got, err := ResignPersonalDevModifyResourceStatusEnvelope(body, "450860000023", "central-app", "central-secret", time.Unix(100, 0), "central-nonce")
	if err != nil {
		t.Fatal(err)
	}
	var env envelope
	if err := json.Unmarshal(got, &env); err != nil {
		t.Fatal(err)
	}
	if env.Interface == nil || env.Interface.Auth == nil || env.Interface.Auth.AppID != "central-app" || env.Interface.Auth.Nonce != "central-nonce" || env.Interface.Auth.Signature == "bad" {
		t.Fatalf("auth=%+v", env.Interface.Auth)
	}
}

func TestResignPersonalDevModifyResourceStatusEnvelopeRejectsTenantMismatch(t *testing.T) {
	body := []byte(`{"interface":{"interfaceName":"qcloud.operation.ModifyResourceStatus","extraPara":{"ownerUin":"450860000024"},"para":{"uin":"450860000024"}}}`)
	if _, err := ResignPersonalDevModifyResourceStatusEnvelope(body, "450860000023", "central-app", "central-secret", time.Now(), "nonce"); err == nil {
		t.Fatal("error=nil")
	}
}
