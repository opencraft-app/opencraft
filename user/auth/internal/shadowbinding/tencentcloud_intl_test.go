package shadowbinding

import "testing"

func TestRegistrationRequestUsesInternationalLevel2EmailContract(t *testing.T) {
	action, params, err := registrationRequest(SiteKindIntl, "intlSaaSLightvela", CloudRegisterInput{
		UserName: "krsbx_u8674708900",
		Email:    "verified@example.com",
		ClientIP: "127.0.0.1",
		ClientUA: "test-agent",
	}, "generated-password")
	if err != nil {
		t.Fatalf("build international registration request: %v", err)
	}
	if action != "RegisterCloudForSaaSIntl" {
		t.Fatalf("action = %q, want RegisterCloudForSaaSIntl", action)
	}
	if params["Area"] != 2 || params["AccessLevel"] != 2 || params["RegisterType"] != "mail" {
		t.Fatalf("unexpected international account contract: %+v", params)
	}
	if params["Email"] != "verified@example.com" || params["UserName"] != "krsbx_u8674708900" {
		t.Fatalf("unexpected international identity parameters: %+v", params)
	}
	if _, ok := params["PhoneNumber"]; ok {
		t.Fatalf("international email registration must not send phone fields: %+v", params)
	}
	if _, ok := params["EmailVerifyCode"]; ok {
		t.Fatalf("level 2 registration must not send email verification code: %+v", params)
	}
}

func TestRegistrationRequestKeepsDomesticPhoneContract(t *testing.T) {
	action, params, err := registrationRequest(SiteKindCN, "lightclaw", CloudRegisterInput{
		UserName:   "u0825080737",
		Phone:      "13800138000",
		VerifyCode: "123456",
	}, "generated-password")
	if err != nil {
		t.Fatalf("build domestic registration request: %v", err)
	}
	if action != "RegisterCloudForSaaS" || params["Area"] != 1 || params["RegisterType"] != "phone" {
		t.Fatalf("unexpected domestic account contract: action=%q params=%+v", action, params)
	}
}

func TestTencentCloudClientUsesSeparateServiceAccountForAppIDLookup(t *testing.T) {
	client, err := NewTencentCloudSDKClient(TencentCloudConfig{
		SecretID:          "saas-secret-id",
		SecretKey:         "saas-secret-key",
		ServiceAccountID:  "service-account-secret-id",
		ServiceAccountKey: "service-account-secret-key",
		SiteKind:          SiteKindIntl,
	})
	if err != nil {
		t.Fatalf("new tencent cloud client: %v", err)
	}
	if client.appIDClient == nil || client.appIDClient == client.accountClient {
		t.Fatal("expected a distinct service-account client for GetAppIdByUin")
	}
}

func TestTencentCloudClientDefaultsAppIDLookupToAccountClient(t *testing.T) {
	client, err := NewTencentCloudSDKClient(TencentCloudConfig{
		SecretID:  "saas-secret-id",
		SecretKey: "saas-secret-key",
		SiteKind:  SiteKindIntl,
	})
	if err != nil {
		t.Fatalf("new tencent cloud client: %v", err)
	}
	if client.appIDClient != client.accountClient {
		t.Fatal("expected backward-compatible account client fallback")
	}
}

func TestTencentCloudClientRejectsPartialServiceAccountCredentials(t *testing.T) {
	_, err := NewTencentCloudSDKClient(TencentCloudConfig{
		SecretID:         "saas-secret-id",
		SecretKey:        "saas-secret-key",
		ServiceAccountID: "service-account-secret-id",
		SiteKind:         SiteKindIntl,
	})
	if err == nil {
		t.Fatal("expected incomplete service-account credentials to fail")
	}
}

func TestParseSiteKindRejectsUnknownValue(t *testing.T) {
	if _, err := ParseSiteKind("korea"); err == nil {
		t.Fatal("expected unknown site kind to be rejected")
	}
	if got, err := ParseSiteKind(" INTL "); err != nil || got != SiteKindIntl {
		t.Fatalf("parse intl site kind: got=%q err=%v", got, err)
	}
}
