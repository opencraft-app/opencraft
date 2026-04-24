package proxycore

import "strings"

func ClassifyProxyErr(err error) string {
	if err == nil {
		return "unknown"
	}
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "timeout"), strings.Contains(msg, "deadline exceeded"), strings.Contains(msg, "i/o timeout"):
		return "timeout"
	case strings.Contains(msg, "connection refused"):
		return "conn_refused"
	case strings.Contains(msg, "connection reset"):
		return "conn_reset"
	case strings.Contains(msg, "no such host"):
		return "dns"
	case strings.Contains(msg, "tls"):
		return "tls"
	default:
		return "transport"
	}
}
