package shadowbinding

import (
	"net/http"

	"github.com/openclaw/openclaw/mono/shared/cloudladdertransport"
)

type CloudLadderConfig struct {
	Enabled        bool
	GatewayBaseURL string
	RouteID        string
	CAMRouteID     string
	STSRouteID     string
	Caller         string
	Secret         string
}

func NewCloudLadderTransport(cfg CloudLadderConfig, base http.RoundTripper) (http.RoundTripper, error) {
	return NewCloudLadderTransportForRoute(cfg, cfg.RouteID, base)
}

func NewCloudLadderTransportForRoute(cfg CloudLadderConfig, routeID string, base http.RoundTripper) (http.RoundTripper, error) {
	if !cfg.Enabled {
		if base != nil {
			return base, nil
		}
		return http.DefaultTransport, nil
	}
	if routeID == "" {
		routeID = cfg.RouteID
	}
	return cloudladdertransport.New(cloudladdertransport.Options{
		GatewayBaseURL: cfg.GatewayBaseURL,
		RouteID:        routeID,
		Caller:         cfg.Caller,
		Secret:         cfg.Secret,
		Base:           base,
	})
}
