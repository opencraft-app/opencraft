package rescue

import (
	"bytes"
	"embed"
	"fmt"
	htmltemplate "html/template"
	"strings"
	texttemplate "text/template"
)

//go:embed templates/*.subject templates/*.html templates/*.txt
var rescueEmailTemplates embed.FS

type exportSuccessEmailTemplateData struct {
	AgentLabel  string
	DownloadURL string
	TTLLabel    string
}

type importSuccessEmailTemplateData struct {
	AgentLabel string
}

type exportFailureEmailTemplateData struct {
	AgentLabel  string
	RemotePaths string
	Reason      string
}

type importFailureEmailTemplateData struct {
	AgentLabel string
	Reason     string
}

func renderRescueTextTemplate(name string, data any) string {
	tmpl, err := texttemplate.ParseFS(rescueEmailTemplates, "templates/"+name)
	if err != nil {
		return rescueEmailTemplateFallback(name, err)
	}
	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, data); err != nil {
		return rescueEmailTemplateFallback(name, err)
	}
	return strings.TrimSpace(buf.String())
}

func renderRescueHTMLTemplate(name string, data any) string {
	tmpl, err := htmltemplate.ParseFS(rescueEmailTemplates, "templates/"+name)
	if err != nil {
		return rescueEmailTemplateFallback(name, err)
	}
	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, data); err != nil {
		return rescueEmailTemplateFallback(name, err)
	}
	return strings.TrimSpace(buf.String())
}

func rescueEmailTemplateFallback(name string, err error) string {
	return fmt.Sprintf("LightVela email template %s render failed: %v", name, err)
}
