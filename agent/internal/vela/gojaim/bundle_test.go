package gojaim

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
)

func TestEmbeddedBundleIsSingleSelfContainedLiteChatAsset(t *testing.T) {
	source := EmbeddedBundle()
	if len(source) < 100_000 {
		t.Fatalf("embedded bundle is unexpectedly small: %d bytes", len(source))
	}
	for _, forbidden := range []string{
		"require(",
		"sourceMappingURL=",
		"@tencentcloud/lite-chat/node.js",
	} {
		if strings.Contains(source, forbidden) {
			t.Fatalf("embedded bundle contains forbidden runtime dependency %q", forbidden)
		}
	}
	for _, required := range []string{
		"TencentCloudChat",
		"__velaLiteChat",
		"__velaHost",
		`if(op==="search")`,
		`if(op==="setReaction")`,
		`if(op==="sendAttachment")`,
		`if(op==="loginState")`,
		`TIMUploadPlugin`,
		`cloudCustomData:String(request.cloud_custom_data||"")`,
		`if(attachmentCloudCustomData)attachmentOptions.cloudCustomData=attachmentCloudCustomData`,
		`function searchHistoryPage(sdk,request)`,
		`if(request.around_time_ms)`,
		`if(request.around_sequence)`,
		`sdk.__velaCloudSearchUnavailable=true`,
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("embedded bundle does not expose %q", required)
		}
	}

	sum := sha256.Sum256([]byte(source))
	if got, want := hex.EncodeToString(sum[:]), BundleSHA256(); got != want {
		t.Fatalf("bundle SHA-256 = %q, want %q", got, want)
	}
}

func TestValidateEmbeddedBundleRejectsMissingFacade(t *testing.T) {
	if err := ValidateBundle("globalThis.TencentCloudChat = {};"); err == nil {
		t.Fatal("ValidateBundle accepted a bundle without the Vela facade")
	}
}

func TestEmbeddedBundleExecutesInGoja(t *testing.T) {
	info, err := ProbeEmbeddedBundle()
	if err != nil {
		t.Fatalf("ProbeEmbeddedBundle: %v", err)
	}
	if !info.HasCreate {
		t.Fatal("embedded LiteChat does not expose create")
	}
	if !info.HasFacade {
		t.Fatal("embedded LiteChat does not expose the Vela facade")
	}
	if info.Version != "4.4.2" {
		t.Fatalf("LiteChat version = %q, want 4.4.2", info.Version)
	}
	if info.ClientID == "" {
		t.Fatal("embedded LiteChat facade did not create a real SDK client")
	}
}
