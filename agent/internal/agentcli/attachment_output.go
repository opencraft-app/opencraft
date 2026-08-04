package agentcli

type attachmentUploadResponse struct {
	ID           string  `json:"id"`
	Filename     string  `json:"filename"`
	MIMEType     *string `json:"mimeType"`
	SizeBytes    float64 `json:"sizeBytes"`
	ThumbnailURL *string `json:"thumbnailUrl"`
}
