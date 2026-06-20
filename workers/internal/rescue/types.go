package rescue

import (
	"fmt"
	"strings"
)

var CommonRegions = []string{
	"ap-guangzhou",
	"ap-shanghai",
	"ap-beijing",
	"ap-nanjing",
	"ap-chengdu",
	"ap-chongqing",
	"ap-hongkong",
	"ap-singapore",
	"ap-tokyo",
	"ap-seoul",
	"na-siliconvalley",
	"na-ashburn",
	"eu-frankfurt",
}

type TemporalConfig struct {
	Address   string
	Namespace string
	TLS       bool
	AuthToken string
	TaskQueue string
}

type TencentConfig struct {
	Region           string
	CredentialFile   string
	RegionCandidates []string
}

const (
	ArchiveModeHermes  = "hermes"
	ArchiveModeGeneric = "generic"
)

type ExportRequest struct {
	BotID                  string
	BotName                string
	InstanceID             string
	Region                 string
	NotificationEmail      string
	NotifyEmail            string
	RescueUsername         string
	RescuePasswordEnv      string
	StopType               string
	ReenterRescue          bool
	DeviceGlobs            []string
	RemotePaths            []string
	ArchiveMode            string
	MountRoot              string
	RemoteWorkDir          string
	LocalOutputDir         string
	CommandTransport       string
	SSHHost                string
	SSHUser                string
	SSHPort                int
	SSHIdentityFile        string
	SSHPasswordEnv         string
	StrictHostKeyChecking  bool
	SCPExtraOptions        []string
	TATUsername            string
	TATWorkingDirectory    string
	TATWaitTimeoutSeconds  int
	TATOutputCOSBucketURL  string
	TATOutputCOSKeyPrefix  string
	COSUploadBucket        string
	COSUploadRegion        string
	COSUploadKeyPrefix     string
	COSUploadURLTTLSeconds int
	KeepRemoteArchive      bool
	DisableCOSAutoDelete   bool
	NotificationEmails     []string
	SearchAttributes       []string
	Execute                bool
	Confirmed              bool
	WaitTimeoutSeconds     int
	CommandTimeoutSeconds  int
}

type ImportRequest struct {
	BotID                  string
	BotName                string
	InstanceID             string
	Region                 string
	RegionCandidates       []string
	NotificationEmail      string
	NotifyEmail            string
	NotificationEmails     []string
	ImportObjectKey        string
	ImportObjectURL        string
	COSUploadBucket        string
	COSUploadRegion        string
	COSUploadKeyPrefix     string
	COSUploadURLTTLSeconds int
	TATUsername            string
	TATWorkingDirectory    string
	TATWaitTimeoutSeconds  int
	SearchAttributes       []string
	Execute                bool
	WaitTimeoutSeconds     int
	CommandTimeoutSeconds  int
}

func NormalizeImportRequest(req ImportRequest) ImportRequest {
	if strings.TrimSpace(req.TATUsername) == "" {
		req.TATUsername = "agentuser"
	}
	if strings.TrimSpace(req.TATWorkingDirectory) == "" {
		req.TATWorkingDirectory = "/home/agentuser"
	}
	if req.TATWaitTimeoutSeconds <= 0 {
		req.TATWaitTimeoutSeconds = req.WaitTimeoutSeconds
	}
	if req.COSUploadURLTTLSeconds <= 0 {
		req.COSUploadURLTTLSeconds = 900
	}
	return req
}

func (req ImportRequest) exportRequest() ExportRequest {
	return ExportRequest{
		BotID:                  req.BotID,
		BotName:                req.BotName,
		InstanceID:             req.InstanceID,
		Region:                 req.Region,
		NotificationEmail:      req.NotificationEmail,
		NotifyEmail:            req.NotifyEmail,
		NotificationEmails:     req.NotificationEmails,
		RemotePaths:            []string{"/home/agentuser/.hermes"},
		ArchiveMode:            ArchiveModeHermes,
		CommandTransport:       "tat",
		TATUsername:            req.TATUsername,
		TATWorkingDirectory:    req.TATWorkingDirectory,
		TATWaitTimeoutSeconds:  req.TATWaitTimeoutSeconds,
		COSUploadBucket:        req.COSUploadBucket,
		COSUploadRegion:        req.COSUploadRegion,
		COSUploadKeyPrefix:     req.COSUploadKeyPrefix,
		COSUploadURLTTLSeconds: req.COSUploadURLTTLSeconds,
		SearchAttributes:       req.SearchAttributes,
		Execute:                req.Execute,
		Confirmed:              true,
		WaitTimeoutSeconds:     req.WaitTimeoutSeconds,
		CommandTimeoutSeconds:  req.CommandTimeoutSeconds,
	}
}

func NormalizeExportRequest(req ExportRequest) ExportRequest {
	req.ArchiveMode = normalizeArchiveMode(req.ArchiveMode)
	if req.ArchiveMode == ArchiveModeHermes && len(req.RemotePaths) == 0 {
		req.RemotePaths = []string{"/home/agentuser/.hermes"}
	}
	if req.CommandTransport == "" {
		req.CommandTransport = "tat"
	}
	return req
}

func ValidateArchiveMode(mode string) error {
	mode = normalizeArchiveMode(mode)
	if mode != ArchiveModeHermes && mode != ArchiveModeGeneric {
		return fmt.Errorf("unknown archive mode %q", mode)
	}
	return nil
}

type InstanceInfo struct {
	InstanceID string
	Region     string
	State      string
	PublicIP   string
	PrivateIP  string
}

type PreparedArchive struct {
	InstanceID    string
	Region        string
	RemotePath    string
	MountedDevice string
	SHA256        string
	ByteSize      int64
	RemoteOutput  string
	ObjectURL     string
	DownloadURL   string
	ObjectKey     string
	Bucket        string
}

type TATCommandRequest struct {
	CommandName    string
	Script         string
	TimeoutSeconds int
}

type PreparedTATArchive struct {
	InstanceID    string
	Region        string
	Mode          string
	Command       TATCommandRequest
	ObjectURL     string
	DownloadURL   string
	ObjectKey     string
	Bucket        string
	RemotePath    string
	MountedDevice string
	SHA256        string
	ByteSize      int64
}

type SCPResult struct {
	LocalPath string
	Command   []string
	Stdout    string
	Stderr    string
	OutputURL string
}

type ExportResult struct {
	Instance              InstanceInfo
	Archive               PreparedArchive
	SCP                   SCPResult
	ExitedRescue          bool
	COSDeleteWorkflowID   string
	COSDeleteAfterSeconds int
	NotificationEmail     string
	EmailMessageID        string
	EmailDelivered        bool
	EmailDeliverStatus    int
	EmailDeliverMessage   string
	DryRun                bool
}

type PreparedImport struct {
	InstanceID   string
	Region       string
	ObjectURL    string
	ObjectKey    string
	Bucket       string
	ArchivePath  string
	ByteSize     int64
	RemoteOutput string
	Command      TATCommandRequest
}

type ImportResult struct {
	Instance            InstanceInfo
	Import              PreparedImport
	TATCommand          TATCommandResult
	COSDeleted          bool
	NotificationEmail   string
	EmailMessageID      string
	EmailDelivered      bool
	EmailDeliverStatus  int
	EmailDeliverMessage string
	DryRun              bool
}

type ExportStatusLog struct {
	Time    string `json:"time"`
	Phase   string `json:"phase"`
	Message string `json:"message"`
	Level   string `json:"level,omitempty"`
}

type ExportStatus struct {
	WorkflowID            string
	RunID                 string
	Phase                 string
	Instance              InstanceInfo
	Archive               PreparedArchive
	SCP                   SCPResult
	TATCommand            TATCommandResult
	ExitedRescue          bool
	COSDeleteWorkflowID   string
	COSDeleteAfterSeconds int
	NotificationEmail     string
	EmailMessageID        string
	EmailDelivered        bool
	EmailDeliverStatus    int
	EmailDeliverMessage   string
	Error                 string
	DryRun                bool
	Logs                  []ExportStatusLog
}

type ImportStatus struct {
	WorkflowID          string
	RunID               string
	Phase               string
	Instance            InstanceInfo
	Import              PreparedImport
	TATCommand          TATCommandResult
	COSDeleted          bool
	NotificationEmail   string
	EmailMessageID      string
	EmailDelivered      bool
	EmailDeliverStatus  int
	EmailDeliverMessage string
	Error               string
	DryRun              bool
	Logs                []ExportStatusLog
}

type COSDeleteRequest struct {
	InstanceID   string
	BucketURL    string
	BucketRegion string
	ObjectKey    string
	ObjectURL    string
	DelaySeconds int
	WorkflowID   string
}

type COSDeleteResult struct {
	ObjectKey string
	ObjectURL string
	Deleted   bool
	DryRun    bool
}
