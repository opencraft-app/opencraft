package rescue

import (
	"encoding/json"
	"net/url"
	"reflect"
	"strings"
	"testing"
)

func TestSignCOSURLIncludesMethodScopedQuerySignature(t *testing.T) {
	signed := signCOSURL("AKIDexample", "secret", "bucket-1250000000.cos.ap-beijing.myqcloud.com", "/rescue/a.tar.gz", 3600, "PUT")
	parsed, err := url.Parse(signed)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	for _, key := range []string{"q-sign-algorithm", "q-ak", "q-sign-time", "q-key-time", "q-header-list", "q-url-param-list", "q-signature"} {
		if _, ok := query[key]; !ok {
			t.Fatalf("missing query key %s in %s", key, signed)
		}
	}
	if query.Get("q-header-list") != "host" {
		t.Fatalf("unexpected signed headers: %s", query.Get("q-header-list"))
	}
	if !strings.HasPrefix(signed, "https://bucket-1250000000.cos.ap-beijing.myqcloud.com/rescue/a.tar.gz?") {
		t.Fatalf("unexpected url: %s", signed)
	}
}

func TestCOSMultipartPolicyUsesBucketAppIDAndLeastPrivilege(t *testing.T) {
	resource, err := cosObjectResource(
		"https://lightclawuser-1388575217.cos.ap-beijing.myqcloud.com",
		"ap-beijing",
		"rescue-exports/instance.zip",
	)
	if err != nil {
		t.Fatal(err)
	}
	wantResource := "qcs::cos:ap-beijing:uid/1388575217:prefix//1388575217/lightclawuser/rescue-exports/instance.zip"
	if resource != wantResource {
		t.Fatalf("resource = %q, want %q", resource, wantResource)
	}

	policyJSON, err := buildCOSMultipartUploadPolicy(resource)
	if err != nil {
		t.Fatal(err)
	}
	var policy struct {
		Statement []struct {
			Action   []string `json:"action"`
			Resource []string `json:"resource"`
		} `json:"statement"`
	}
	if err := json.Unmarshal([]byte(policyJSON), &policy); err != nil {
		t.Fatal(err)
	}
	if len(policy.Statement) != 1 {
		t.Fatalf("statement = %#v", policy.Statement)
	}
	wantActions := []string{"name/cos:UploadPart", "name/cos:CompleteMultipartUpload"}
	if !reflect.DeepEqual(policy.Statement[0].Action, wantActions) {
		t.Fatalf("actions = %#v", policy.Statement[0].Action)
	}
	if !reflect.DeepEqual(policy.Statement[0].Resource, []string{wantResource}) {
		t.Fatalf("resources = %#v", policy.Statement[0].Resource)
	}
}

func TestCOSMultipartCredentialTTLIncludesCommandCleanupMargin(t *testing.T) {
	if got := cosMultipartCredentialTTL(1800); got != 2400 {
		t.Fatalf("ttl = %d, want 2400", got)
	}
	if got := cosMultipartCredentialTTL(0); got != 1800 {
		t.Fatalf("default ttl = %d, want 1800", got)
	}
	if got := cosMultipartCredentialTTL(10_000); got != 7200 {
		t.Fatalf("capped ttl = %d, want 7200", got)
	}
}

func TestParseFederationCredentialsRejectsIncompleteResponse(t *testing.T) {
	if _, err := parseFederationCredentials(map[string]any{
		"Credentials": map[string]any{"TmpSecretId": "temporary-id"},
	}); err == nil {
		t.Fatal("expected incomplete credential response to fail")
	}
}

func TestCOSObjectKeyUsesArchiveModeExtension(t *testing.T) {
	hermes := cosObjectKey(ExportRequest{InstanceID: "ins-test", COSUploadKeyPrefix: "rescue", ArchiveMode: ArchiveModeHermes})
	if !strings.HasPrefix(hermes, "rescue/ins-test-") || !strings.HasSuffix(hermes, ".zip") {
		t.Fatalf("unexpected hermes object key: %s", hermes)
	}

	generic := cosObjectKey(ExportRequest{InstanceID: "ins-test", COSUploadKeyPrefix: "rescue", ArchiveMode: ArchiveModeGeneric})
	if !strings.HasPrefix(generic, "rescue/ins-test-") || !strings.HasSuffix(generic, ".tar.gz") {
		t.Fatalf("unexpected generic object key: %s", generic)
	}
}
