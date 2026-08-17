package httpapi

import (
	"encoding/json"
	"net/http"
)

// NewAdminHandler 提供健康检查。
//
// 单独一个 handler 是为了挂在独立端口上：站点入口的路径空间完全属于用户站点，
// 在那里注册 /healthz 会占用用户可能用到的路径，也会让探针请求走进站点解析逻辑。
func NewAdminHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", writeStatusOK)
	mux.HandleFunc("/livez", writeStatusOK)
	mux.HandleFunc("/readyz", writeStatusOK)
	return mux
}

func writeStatusOK(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}
