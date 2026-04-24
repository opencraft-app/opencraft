package accesslog

import "time"

type Entry struct {
	Timestamp     time.Time `json:"timestamp"`
	Method        string    `json:"method"`
	Path          string    `json:"path"`
	Status        int       `json:"status"`
	DurationMS    int64     `json:"duration_ms"`
	RouteName     string    `json:"route_name,omitempty"`
	RemoteAddr    string    `json:"remote_addr,omitempty"`
	UserAgent     string    `json:"user_agent,omitempty"`
	Referer       string    `json:"referer,omitempty"`
	Origin        string    `json:"origin,omitempty"`
	UserID        string    `json:"user_id,omitempty"`
	UserEmail     string    `json:"user_email,omitempty"`
	PlanTier      string    `json:"plan_tier,omitempty"`
	AdminAuthMode string    `json:"admin_auth_mode,omitempty"`
}
