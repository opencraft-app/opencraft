package proxycore

import "net/url"

type Destination struct {
	URL           *url.URL
	ConnectionKey string
	PreserveHost  bool
	Observer      any
}
