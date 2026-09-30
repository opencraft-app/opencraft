package common

// SafeVelaGWTraceID accepts only the 16-character URL-safe identifier generated
// by VelaGW. Direct NewAPI callers may supply this header, so do not log it raw.
func SafeVelaGWTraceID(value string) string {
	if len(value) != 16 {
		return "none"
	}
	for _, ch := range value {
		if !((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
			(ch >= '0' && ch <= '9') || ch == '-' || ch == '_') {
			return "none"
		}
	}
	return value
}
