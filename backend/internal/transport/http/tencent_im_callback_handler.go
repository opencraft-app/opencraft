package httptransport

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"

	appagentpresence "chatserver/internal/app/agentpresence"
	clockport "chatserver/internal/ports/clock"
)

const (
	tencentIMStateCommand = "State.StateChange"
	callbackClockSkew     = time.Minute
)

type TencentIMStateCallbackConfig struct {
	SDKAppID     int64
	Token        []byte
	Clock        clockport.Clock
	MaxBodyBytes int64
}

type imPresenceObserver interface {
	ObserveIMPresence(
		context.Context,
		appagentpresence.IMObservation,
	) error
}

type tencentIMStateCallbackHandler struct {
	config   TencentIMStateCallbackConfig
	observer imPresenceObserver
}

func NewTencentIMStateCallbackHandler(
	config TencentIMStateCallbackConfig,
	observer imPresenceObserver,
) (http.Handler, error) {
	if config.SDKAppID <= 0 ||
		len(config.Token) == 0 ||
		len(config.Token) > 128 ||
		config.Clock == nil ||
		config.MaxBodyBytes <= 0 ||
		config.MaxBodyBytes > 16<<10 ||
		observer == nil {
		return nil, errors.New("腾讯 IM 状态回调配置无效")
	}
	return &tencentIMStateCallbackHandler{
		config:   config,
		observer: observer,
	}, nil
}

func (handler *tencentIMStateCallbackHandler) ServeHTTP(
	writer http.ResponseWriter,
	request *http.Request,
) {
	if request.Method != http.MethodPost {
		writer.Header().Set("Allow", http.MethodPost)
		http.Error(writer, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !handler.authenticate(request) {
		http.Error(writer, "unauthorized", http.StatusUnauthorized)
		return
	}
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		http.Error(writer, "invalid content type", http.StatusBadRequest)
		return
	}
	body, err := io.ReadAll(io.LimitReader(
		request.Body,
		handler.config.MaxBodyBytes+1,
	))
	if err != nil || int64(len(body)) > handler.config.MaxBodyBytes {
		http.Error(writer, "invalid body", http.StatusBadRequest)
		return
	}
	var callback struct {
		CallbackCommand string `json:"CallbackCommand"`
		EventTime       int64  `json:"EventTime"`
		Info            struct {
			Action    string `json:"Action"`
			ToAccount string `json:"To_Account"`
			Reason    string `json:"Reason"`
		} `json:"Info"`
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	if err := decoder.Decode(&callback); err != nil {
		http.Error(writer, "invalid body", http.StatusBadRequest)
		return
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		http.Error(writer, "invalid body", http.StatusBadRequest)
		return
	}
	if callback.CallbackCommand != tencentIMStateCommand ||
		callback.EventTime <= 0 {
		http.Error(writer, "invalid callback", http.StatusBadRequest)
		return
	}
	var presence string
	switch callback.Info.Action {
	case "Login":
		presence = "online"
	case "Logout", "Disconnect":
		presence = "offline"
	case "CustomStatusChange":
		handler.acknowledge(writer)
		return
	default:
		handler.acknowledge(writer)
		return
	}
	if strings.TrimSpace(callback.Info.ToAccount) == "" ||
		len(callback.Info.ToAccount) > 128 ||
		len(callback.Info.Reason) > 256 {
		http.Error(writer, "invalid callback", http.StatusBadRequest)
		return
	}
	if err := handler.observer.ObserveIMPresence(
		request.Context(),
		appagentpresence.IMObservation{
			IMUserID:   callback.Info.ToAccount,
			Presence:   presence,
			ObservedAt: time.UnixMilli(callback.EventTime).UTC(),
			Reason:     callback.Info.Reason,
		},
	); err != nil {
		http.Error(writer, "temporary failure", http.StatusInternalServerError)
		return
	}
	handler.acknowledge(writer)
}

func (handler *tencentIMStateCallbackHandler) authenticate(
	request *http.Request,
) bool {
	query := request.URL.Query()
	sdkAppID, ok := singleQueryValue(query["SdkAppid"])
	if !ok || sdkAppID != strconv.FormatInt(handler.config.SDKAppID, 10) {
		return false
	}
	command, ok := singleQueryValue(query["CallbackCommand"])
	if !ok || command != tencentIMStateCommand {
		return false
	}
	contentType, ok := singleQueryValue(query["contenttype"])
	if !ok || contentType != "json" {
		return false
	}
	requestTimeValue, ok := singleQueryValue(query["RequestTime"])
	if !ok {
		return false
	}
	requestTimeUnix, err := strconv.ParseInt(requestTimeValue, 10, 64)
	if err != nil {
		return false
	}
	requestTime := time.Unix(requestTimeUnix, 0).UTC()
	delta := handler.config.Clock.Now().UTC().Sub(requestTime)
	if delta < -callbackClockSkew || delta > callbackClockSkew {
		return false
	}
	signatureHex, ok := singleQueryValue(query["Sign"])
	if !ok || len(signatureHex) != sha256.Size*2 {
		return false
	}
	provided, err := hex.DecodeString(signatureHex)
	if err != nil || len(provided) != sha256.Size {
		return false
	}
	material := make([]byte, 0, len(handler.config.Token)+len(requestTimeValue))
	material = append(material, handler.config.Token...)
	material = append(material, requestTimeValue...)
	expected := sha256.Sum256(material)
	return subtle.ConstantTimeCompare(provided, expected[:]) == 1
}

func (handler *tencentIMStateCallbackHandler) acknowledge(
	writer http.ResponseWriter,
) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(
		writer,
		`{"ActionStatus":"OK","ErrorCode":0,"ErrorInfo":""}`,
	)
}

func singleQueryValue(values []string) (string, bool) {
	if len(values) != 1 || values[0] == "" {
		return "", false
	}
	return values[0], true
}
