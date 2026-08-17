// Package computerupdate maps the independent Computer Update application service to its strict API.
package computerupdate

import (
	"context"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"

	api "chatserver/internal/api/computerupdate"
	update "chatserver/internal/computerupdate"

	"github.com/google/uuid"
)

type updateService interface {
	GetChannel(context.Context, string, string) (update.ChannelEnvelope, error)
	ListChannels() ([]update.ChannelView, error)
	ListAudit(int) ([]update.AuditEntry, error)
	Promote(context.Context, update.PromoteCommand) ([]update.ChannelView, error)
}

type Handler struct {
	api.StrictServerInterface
	service updateService
}

func NewHandler(service updateService) (*Handler, error) {
	if service == nil {
		return nil, errors.New("Computer Update service 为空")
	}
	return &Handler{service: service}, nil
}

type operatorFingerprintContextKey struct{}
type requestIDContextKey struct{}

func WithOperatorFingerprint(ctx context.Context, fingerprint []byte) context.Context {
	if ctx == nil || len(fingerprint) != 32 {
		return ctx
	}
	return context.WithValue(
		ctx,
		operatorFingerprintContextKey{},
		append([]byte(nil), fingerprint...),
	)
}

func WithRequestID(ctx context.Context, requestID string) context.Context {
	if ctx == nil || strings.TrimSpace(requestID) == "" {
		return ctx
	}
	return context.WithValue(ctx, requestIDContextKey{}, strings.TrimSpace(requestID))
}

func (handler *Handler) GetComputerReleaseChannel(
	ctx context.Context,
	request api.GetComputerReleaseChannelRequestObject,
) (api.GetComputerReleaseChannelResponseObject, error) {
	value, err := handler.service.GetChannel(
		ctx,
		string(request.Channel),
		string(request.Target),
	)
	if err != nil {
		body, status := mapError(ctx, err)
		return api.GetComputerReleaseChanneldefaultJSONResponse{
			Body: body, StatusCode: status,
			Headers: errorHeaders(),
		}, nil
	}
	return api.GetComputerReleaseChannel200JSONResponse{
		Body: channelEnvelopeDTO(value),
		Headers: api.GetComputerReleaseChannel200ResponseHeaders{
			CacheControl: "no-store", ETag: value.ETag,
		},
	}, nil
}

func (handler *Handler) ListComputerReleaseChannels(
	ctx context.Context,
	_ api.ListComputerReleaseChannelsRequestObject,
) (api.ListComputerReleaseChannelsResponseObject, error) {
	if _, ok := operatorFingerprint(ctx); !ok {
		return api.ListComputerReleaseChannelsdefaultJSONResponse{
			Body:       errorEnvelope(ctx, "operator_forbidden", "平台运营身份无效"),
			StatusCode: 403, Headers: errorHeaders(),
		}, nil
	}
	values, err := handler.service.ListChannels()
	if err != nil {
		body, status := mapError(ctx, err)
		return api.ListComputerReleaseChannelsdefaultJSONResponse{
			Body: body, StatusCode: status, Headers: errorHeaders(),
		}, nil
	}
	return api.ListComputerReleaseChannels200JSONResponse{
		Body:    channelViewsDTO(values),
		Headers: api.ListComputerReleaseChannels200ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (handler *Handler) PromoteComputerReleaseChannel(
	ctx context.Context,
	request api.PromoteComputerReleaseChannelRequestObject,
) (api.PromoteComputerReleaseChannelResponseObject, error) {
	fingerprint, ok := operatorFingerprint(ctx)
	if !ok {
		return api.PromoteComputerReleaseChanneldefaultJSONResponse{
			Body:       errorEnvelope(ctx, "operator_forbidden", "平台运营身份无效"),
			StatusCode: 403, Headers: errorHeaders(),
		}, nil
	}
	if request.Body == nil {
		return api.PromoteComputerReleaseChanneldefaultJSONResponse{
			Body:       errorEnvelope(ctx, "invalid_request", "请求体不能为空"),
			StatusCode: 400, Headers: errorHeaders(),
		}, nil
	}
	expected, err := parseIfMatch(request.Params.IfMatch)
	if err != nil {
		return api.PromoteComputerReleaseChanneldefaultJSONResponse{
			Body:       errorEnvelope(ctx, "invalid_request", "If-Match 无效"),
			StatusCode: 400, Headers: errorHeaders(),
		}, nil
	}
	values, err := handler.service.Promote(ctx, update.PromoteCommand{
		Channel: string(request.Channel), ExpectedSequence: expected,
		Version:             request.Body.Version,
		OperatorFingerprint: fingerprint,
	})
	if err != nil {
		body, status := mapError(ctx, err)
		return api.PromoteComputerReleaseChanneldefaultJSONResponse{
			Body: body, StatusCode: status, Headers: errorHeaders(),
		}, nil
	}
	return api.PromoteComputerReleaseChannel200JSONResponse{
		Body:    channelViewsDTO(values),
		Headers: api.PromoteComputerReleaseChannel200ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (handler *Handler) ListComputerReleaseAudit(
	ctx context.Context,
	request api.ListComputerReleaseAuditRequestObject,
) (api.ListComputerReleaseAuditResponseObject, error) {
	if _, ok := operatorFingerprint(ctx); !ok {
		return api.ListComputerReleaseAuditdefaultJSONResponse{
			Body:       errorEnvelope(ctx, "operator_forbidden", "平台运营身份无效"),
			StatusCode: 403, Headers: errorHeaders(),
		}, nil
	}
	limit := 50
	if request.Params.Limit != nil {
		limit = *request.Params.Limit
	}
	values, err := handler.service.ListAudit(limit)
	if err != nil {
		body, status := mapError(ctx, err)
		return api.ListComputerReleaseAuditdefaultJSONResponse{
			Body: body, StatusCode: status, Headers: errorHeaders(),
		}, nil
	}
	items := make([]api.ComputerReleaseAuditEntry, 0, len(values))
	for _, value := range values {
		id, err := uuid.Parse(value.ID)
		if err != nil {
			body, status := mapError(ctx, update.ErrCorruptStore)
			return api.ListComputerReleaseAuditdefaultJSONResponse{
				Body: body, StatusCode: status, Headers: errorHeaders(),
			}, nil
		}
		items = append(items, api.ComputerReleaseAuditEntry{
			Id:                  id,
			OperatorFingerprint: value.OperatorFingerprint,
			Channel:             api.ComputerReleaseAuditEntryChannel(value.Channel),
			FromSequence:        value.FromSequence, ToSequence: value.ToSequence,
			Version: value.Version, CreatedAt: value.CreatedAt.UTC(),
		})
	}
	return api.ListComputerReleaseAudit200JSONResponse{
		Body:    api.ComputerReleaseAuditPage{Items: items},
		Headers: api.ListComputerReleaseAudit200ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func channelEnvelopeDTO(value update.ChannelEnvelope) api.ComputerReleaseChannelEnvelope {
	return api.ComputerReleaseChannelEnvelope{
		SchemaVersion: api.ComputerReleaseChannelEnvelopeSchemaVersionN1,
		Payload:       value.Signed.Payload,
		Signature: api.ComputerReleaseSignature{
			Algorithm: api.Ed25519,
			KeyId:     value.Signed.Signature.KeyID,
			Value:     value.Signed.Signature.Value,
		},
		Downloads: api.ComputerReleaseDownloads{
			CatalogUrl:           value.Downloads.CatalogURL,
			ManifestUrl:          value.Downloads.ManifestURL,
			ManifestSignatureUrl: value.Downloads.ManifestSignatureURL,
			ProgramUrl:           value.Downloads.ProgramURL,
			ExpiresAt:            value.Downloads.ExpiresAt.UTC(),
		},
	}
}

func channelViewsDTO(values []update.ChannelView) []api.ComputerReleaseChannelView {
	result := make([]api.ComputerReleaseChannelView, 0, len(values))
	for _, value := range values {
		result = append(result, api.ComputerReleaseChannelView{
			Channel:  api.ComputerReleaseChannelViewChannel(value.Channel),
			Target:   api.ComputerReleaseChannelViewTarget(value.Target),
			Sequence: value.Sequence, ExpectedVersion: value.ExpectedVersion,
			CatalogSHA256:    value.CatalogSHA256,
			DescriptorSHA256: value.DescriptorSHA256,
			IssuedAt:         value.IssuedAt.UTC(), KeyId: value.KeyID,
		})
	}
	return result
}

func parseIfMatch(value string) (int64, error) {
	if len(value) < 3 || value[0] != '"' || value[len(value)-1] != '"' {
		return 0, errors.New("invalid If-Match")
	}
	sequence, err := strconv.ParseInt(value[1:len(value)-1], 10, 64)
	if err != nil || sequence < 0 || strconv.FormatInt(sequence, 10) != value[1:len(value)-1] {
		return 0, errors.New("invalid If-Match")
	}
	return sequence, nil
}

func operatorFingerprint(ctx context.Context) ([]byte, bool) {
	if ctx == nil {
		return nil, false
	}
	value, ok := ctx.Value(operatorFingerprintContextKey{}).([]byte)
	if !ok || len(value) != 32 {
		return nil, false
	}
	return append([]byte(nil), value...), true
}

func requestID(ctx context.Context) string {
	if ctx != nil {
		if value, ok := ctx.Value(requestIDContextKey{}).(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return "request-id-unavailable"
}

func errorEnvelope(ctx context.Context, code, message string) api.ErrorEnvelope {
	return api.ErrorEnvelope{Error: api.ErrorDetail{
		Code: code, Message: message, RequestId: requestID(ctx),
	}}
}

func errorHeaders() api.ErrorResponseHeaders {
	return api.ErrorResponseHeaders{CacheControl: "no-store", Pragma: "no-cache"}
}

func mapError(ctx context.Context, err error) (api.ErrorEnvelope, int) {
	switch {
	case errors.Is(err, update.ErrInvalidDescriptor):
		return errorEnvelope(ctx, "invalid_request", "请求参数无效"), 400
	case errors.Is(err, update.ErrReleaseNotFound):
		return errorEnvelope(ctx, "release_not_found", "Computer Release 不存在"), 404
	case errors.Is(err, update.ErrReleaseIncomplete):
		return errorEnvelope(ctx, "release_incomplete", "Computer Release 不完整"), 409
	case errors.Is(err, update.ErrRevisionConflict):
		return errorEnvelope(ctx, "revision_conflict", "Computer Release Channel 已变化"), 409
	case errors.Is(err, update.ErrChannelSigning):
		return errorEnvelope(ctx, "channel_signing_unavailable", "Channel 暂时无法签名"), 503
	case errors.Is(err, update.ErrUpdateStorage), errors.Is(err, update.ErrCorruptStore):
		return errorEnvelope(ctx, "update_storage_unavailable", "Computer Update storage 暂时不可用"), 503
	default:
		return errorEnvelope(ctx, "internal_error", "Computer Update 暂时不可用"), 500
	}
}

func DecodeOperatorFingerprint(value string) ([]byte, error) {
	decoded, err := hex.DecodeString(strings.ToLower(strings.TrimSpace(value)))
	if err != nil || len(decoded) != 32 || hex.EncodeToString(decoded) != strings.ToLower(strings.TrimSpace(value)) {
		return nil, errors.New("operator fingerprint invalid")
	}
	return decoded, nil
}

var _ api.StrictServerInterface = (*Handler)(nil)
