package gateway

import (
	"errors"
	"net"
	"net/url"
	"strings"
)

type Config struct {
	Addr           string
	StaticDir      string
	Command        []string
	Token          string
	FileAPIBaseURL string
}

func (c Config) Validate() error {
	if len(c.Command) == 0 || strings.TrimSpace(c.Command[0]) == "" {
		return errors.New("ACP command is required")
	}
	if strings.TrimSpace(c.FileAPIBaseURL) != "" {
		if _, err := url.ParseRequestURI(c.FileAPIBaseURL); err != nil {
			return err
		}
	}
	host, _, err := net.SplitHostPort(c.Addr)
	if err != nil {
		return err
	}
	if isLoopbackHost(host) {
		return nil
	}
	if strings.TrimSpace(c.Token) == "" {
		return AppError{Code: "security", Kind: "token_required", Message: "non-loopback bind requires MYCHAT_TOKEN or --token"}
	}
	return nil
}

func isLoopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
