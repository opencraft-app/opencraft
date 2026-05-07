package proxy

import "net/http"

type Request struct {
	RequestID  string
	Caller     string
	RouteID    string
	Method     string
	Path       string
	Query      string
	Headers    http.Header
	Body       []byte
	Attributes map[string]string
}

type Response struct {
	StatusCode        int
	Headers           http.Header
	Body              []byte
	UpstreamURL       string
	WebhookDeliveries []WebhookDelivery
}

type WebhookDelivery struct {
	ID         string
	Mode       string
	Status     string
	StatusCode int
	Error      string
	TargetURL  string
}
