package terminal

type Frame struct {
	Type    string            `json:"type"`
	Command string            `json:"command,omitempty"`
	Data    string            `json:"data,omitempty"`
	Output  string            `json:"output,omitempty"`
	Message string            `json:"message,omitempty"`
	Mode    string            `json:"mode,omitempty"`
	Cols    int               `json:"cols,omitempty"`
	Rows    int               `json:"rows,omitempty"`
	Code    int               `json:"code,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
}
