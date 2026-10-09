package computerupdate

import (
	"bytes"
	"context"
	"testing"
	"time"

	api "chatserver/internal/api/computerupdate"
	update "chatserver/internal/computerupdate"
)

type fakeUpdateService struct {
	envelope update.ChannelEnvelope
	views    []update.ChannelView
	audit    []update.AuditEntry
	promote  update.PromoteCommand
	err      error
}

func (service *fakeUpdateService) GetChannel(
	context.Context,
	string,
	string,
) (update.ChannelEnvelope, error) {
	return service.envelope, service.err
}

func (service *fakeUpdateService) ListChannels() ([]update.ChannelView, error) {
	return service.views, service.err
}

func (service *fakeUpdateService) ListAudit(int) ([]update.AuditEntry, error) {
	return service.audit, service.err
}

func (service *fakeUpdateService) Promote(
	_ context.Context,
	command update.PromoteCommand,
) ([]update.ChannelView, error) {
	service.promote = command
	return service.views, service.err
}

func TestHandlerReturnsAnonymousSignedChannel(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 17, 16, 0, 0, 0, time.UTC)
	service := &fakeUpdateService{envelope: update.ChannelEnvelope{
		Signed: update.SignedDescriptor{
			SchemaVersion: 1, Payload: "c2lnbmVkLXBheWxvYWQ",
			Signature: update.ChannelSignature{
				Algorithm: "ed25519", KeyID: "channel-key-1",
				Value: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
			},
		},
		Downloads: update.ChannelDownloads{
			CatalogURL:           "https://cos.ap-beijing.myqcloud.com/catalog",
			ManifestURL:          "https://cos.ap-beijing.myqcloud.com/manifest",
			ManifestSignatureURL: "https://cos.ap-beijing.myqcloud.com/signature",
			ProgramURL:           "https://cos.ap-beijing.myqcloud.com/program",
			ExpiresAt:            now.Add(5 * time.Minute),
		},
		ETag: `"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"`,
	}}
	handler, err := NewHandler(service)
	if err != nil {
		t.Fatal(err)
	}
	response, err := handler.GetComputerReleaseChannel(
		context.Background(),
		api.GetComputerReleaseChannelRequestObject{
			Channel: api.ChannelStable,
			Target:  api.LinuxAmd64,
		},
	)
	accepted, ok := response.(api.GetComputerReleaseChannel200JSONResponse)
	if err != nil || !ok || accepted.Headers.CacheControl != "no-store" ||
		accepted.Headers.ETag != service.envelope.ETag ||
		accepted.Body.Payload != service.envelope.Signed.Payload ||
		accepted.Body.Downloads.ProgramUrl != service.envelope.Downloads.ProgramURL {
		t.Fatalf("GetComputerReleaseChannel() = (%#v, %v)", response, err)
	}
}

func TestHandlerRequiresTrustedOperatorForPromotion(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 17, 16, 0, 0, 0, time.UTC)
	service := &fakeUpdateService{views: []update.ChannelView{{
		Channel: "stable", Target: "darwin-arm64", Sequence: 1,
		ExpectedVersion:  "v0.1.51",
		CatalogSHA256:    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		DescriptorSHA256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		IssuedAt:         now, KeyID: "channel-key-1",
	}}}
	handler, err := NewHandler(service)
	if err != nil {
		t.Fatal(err)
	}
	request := api.PromoteComputerReleaseChannelRequestObject{
		Channel: api.ChannelStable,
		Params:  api.PromoteComputerReleaseChannelParams{IfMatch: `"0"`},
		Body:    &api.PromoteComputerReleaseChannelRequest{Version: "v0.1.51"},
	}
	response, err := handler.PromoteComputerReleaseChannel(context.Background(), request)
	denied, ok := response.(api.PromoteComputerReleaseChanneldefaultJSONResponse)
	if err != nil || !ok || denied.StatusCode != 403 ||
		denied.Body.Error.Code != "operator_forbidden" {
		t.Fatalf("anonymous Promote() = (%#v, %v)", response, err)
	}

	fingerprint := bytes.Repeat([]byte{0x31}, 32)
	response, err = handler.PromoteComputerReleaseChannel(
		WithOperatorFingerprint(context.Background(), fingerprint),
		request,
	)
	accepted, ok := response.(api.PromoteComputerReleaseChannel200JSONResponse)
	if err != nil || !ok || accepted.Headers.CacheControl != "no-store" ||
		service.promote.Channel != "stable" ||
		service.promote.ExpectedSequence != 0 ||
		service.promote.Version != "v0.1.51" ||
		!bytes.Equal(service.promote.OperatorFingerprint, fingerprint) {
		t.Fatalf("authorized Promote() = (%#v, %v), command=%#v", response, err, service.promote)
	}
}
