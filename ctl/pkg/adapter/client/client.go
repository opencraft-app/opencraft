// Package client ...
package client

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
	"go.uber.org/zap"
	"github.com/google/uuid"

	"ctl/pkg/context"
	"ctl/pkg/metric"
	"ctl/pkg/tracing"
)

// Request ...
type Request struct {
	Method     string
	Url        string
	Body       []byte
	Ip         string
	ExtHeaders map[string]string

	Service string
	Action  string
}

// ToHttpRequest ...
func (r *Request) ToHttpRequest() (*http.Request, error) {
	request, err := http.NewRequest(r.Method, r.Url, bytes.NewReader(r.Body))
	if err != nil {
		return nil, err
	}

	if r.ExtHeaders != nil {
		for k, v := range r.ExtHeaders {
			request.Header.Set(k, v)
		}
	}

	headerHost := request.Header.Get("Host")
	if headerHost != "" {
		request.Host = headerHost
		request.URL.Host = headerHost
	} else {
		request.Host = request.URL.Host
		if r.Ip != "" {
			s := strings.Split(request.URL.Host, ":")
			s[0] = r.Ip
			request.URL.Host = strings.Join(s, ":")
		}
	}

	return request, nil
}

// Response ...
type Response struct {
	T        time.Duration
	Contents []byte

	*http.Response
}

// Client ...
type Client struct {
	client *http.Client
}

// NewClient ...
func NewClient(config *Config) *Client {
	return &Client{
		client: &http.Client{
			Timeout: config.Timeout,

			Transport: &http.Transport{
				DialContext: (&net.Dialer{
					Timeout:   config.Timeout,
					KeepAlive: config.KeepAliveTime,
				}).DialContext,
				DisableKeepAlives:   config.DisableKeepAlives,
				MaxIdleConns:        config.MaxIdleConns,
				MaxIdleConnsPerHost: config.MaxIdleConnsPerHost,
				IdleConnTimeout:     config.IdleConnTimeout,
			},
		},
	}
}

// Do ...
func (c *Client) Do(ctx context.Context, req *Request) (resp *Response, err error) {
	request, err := req.ToHttpRequest()
	if err != nil {
		return nil, err
	}

	logger := ctx.Logger().With(zap.String("rid", uuid.New().String()))

	logger.Info("Send Request",
		zap.String("RequestUrl", req.Url),
		zap.Any("RequestBody", c.makeLogFieldBody(req.Body)),
		zap.Any("RequestHeader", request.Header),
	)

	metric.AdapterRequestTotalCounterVec.WithLabelValues(req.Service, req.Action).Inc()
	defer func() {
		if err != nil {
			metric.AdapterRequestErrorTotalCounterVec.WithLabelValues(req.Service, req.Action, "client.Do").Inc()
		}
	}()

	_, span := tracing.StartTrace(ctx, fmt.Sprintf("Request %s.%s", req.Service, req.Action))
	span.SetAttributes(attribute.String(tracing.SpanAttributeKeyAction,
		fmt.Sprintf("%s.%s", req.Service, req.Action)))
	defer func() { span.EndWithError(err) }()

	headerContent, _ := json.Marshal(request.Header)
	span.AddEvent("request", trace.WithAttributes(
		attribute.String("body", string(req.Body)),
		attribute.String("header", string(headerContent)),
	))

	var response *http.Response
	start := time.Now()
	response, err = c.client.Do(request)
	cost := time.Since(start)

	if response != nil {
		defer func() {
			_ = response.Body.Close()
		}()
	}

	if err != nil {
		return nil, fmt.Errorf("client.Do error: %w", err)
	}

	body, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, fmt.Errorf("ioutil.ReadAll error: %w", err)
	}

	headerContent, _ = json.Marshal(response.Header)
	span.AddEvent("response", trace.WithAttributes(
		attribute.String("body", string(body)),
		attribute.String("header", string(headerContent)),
	))

	logger.Info("Receive response",
		zap.Any("ResponseBody", c.makeLogFieldBody(body)),
		zap.String("ResponseStatus", response.Status),
		zap.Any("ResponseHeader", response.Header),
		zap.String("Cost", cost.String()),
	)

	metric.AdapterLatencyHistogramVec.WithLabelValues(req.Service, req.Action).
		Observe(float64(cost / time.Millisecond))

	return &Response{
		T:        cost,
		Contents: body,
		Response: response,
	}, nil
}

func (c *Client) makeLogFieldBody(body []byte) interface{} {
	m := make(map[string]interface{})
	err := json.Unmarshal(body, &m)
	if err == nil {
		return m
	}
	return string(body)
}
