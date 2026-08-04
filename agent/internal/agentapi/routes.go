package agentapi

import (
	"net/http"
	"strings"
)

const BasePath = "/internal/agent-api"

type Operation string

const (
	Events                Operation = "events.get"
	HistoryRead           Operation = "history.read"
	MessageSend           Operation = "message.send"
	MessageResolve        Operation = "message.resolve"
	MessageSearch         Operation = "message.search"
	MessageReactionAdd    Operation = "message.reaction.add"
	MessageReactionRemove Operation = "message.reaction.remove"
	ChannelMembers        Operation = "channel.members"
	ChannelResolve        Operation = "channel.resolve"
	ServerInfo            Operation = "server.info"
	TaskClaim             Operation = "task.claim"
	TaskList              Operation = "task.list"
	TaskUpdateStatus      Operation = "task.update-status"
	ReminderList          Operation = "reminder.list"
	ReminderCreate        Operation = "reminder.create"
	ReminderCancel        Operation = "reminder.cancel"
	ReminderSnooze        Operation = "reminder.snooze"
	ReminderUpdate        Operation = "reminder.update"
	ReminderLog           Operation = "reminder.log"
	AttachmentUpload      Operation = "attachment.upload"
	AttachmentDownload    Operation = "attachment.download"
	InboxCheck            Operation = "inbox.check"
)

type Route struct {
	Method     string
	Path       string
	Capability string
	Binary     bool
}

var routes = map[Operation]Route{
	Events:                {Method: http.MethodGet, Path: "/events", Capability: "read"},
	HistoryRead:           {Method: http.MethodGet, Path: "/history", Capability: "read"},
	MessageSend:           {Method: http.MethodPost, Path: "/send", Capability: "send"},
	MessageResolve:        {Method: http.MethodGet, Path: "/messages/:msgId/resolve", Capability: "read"},
	MessageSearch:         {Method: http.MethodGet, Path: "/search", Capability: "read"},
	MessageReactionAdd:    {Method: http.MethodPost, Path: "/messages/:msgId/reactions", Capability: "reactions"},
	MessageReactionRemove: {Method: http.MethodDelete, Path: "/messages/:msgId/reactions", Capability: "reactions"},
	ChannelMembers:        {Method: http.MethodGet, Path: "/channel-members", Capability: "channels"},
	ChannelResolve:        {Method: http.MethodPost, Path: "/resolve-channel", Capability: "send"},
	ServerInfo:            {Method: http.MethodGet, Path: "/server", Capability: "server"},
	TaskClaim:             {Method: http.MethodPost, Path: "/tasks/claim", Capability: "tasks"},
	TaskList:              {Method: http.MethodGet, Path: "/tasks", Capability: "tasks"},
	TaskUpdateStatus:      {Method: http.MethodPost, Path: "/tasks/update-status", Capability: "tasks"},
	ReminderList:          {Method: http.MethodGet, Path: "/reminders", Capability: "reminders"},
	ReminderCreate:        {Method: http.MethodPost, Path: "/reminders", Capability: "reminders"},
	ReminderCancel:        {Method: http.MethodDelete, Path: "/reminders/:reminderId", Capability: "reminders"},
	ReminderSnooze:        {Method: http.MethodPost, Path: "/reminders/:reminderId/snooze", Capability: "reminders"},
	ReminderUpdate:        {Method: http.MethodPatch, Path: "/reminders/:reminderId", Capability: "reminders"},
	ReminderLog:           {Method: http.MethodGet, Path: "/reminders/:reminderId/log", Capability: "reminders"},
	AttachmentUpload:      {Method: http.MethodPost, Path: "/upload", Capability: "attachments"},
	AttachmentDownload:    {Method: http.MethodGet, Path: "/attachments/:attachmentId", Capability: "attachments", Binary: true},
	InboxCheck:            {Method: http.MethodGet, Path: "/inbox", Capability: "read"},
}

func Lookup(operation Operation) (Route, bool) {
	route, ok := routes[operation]
	return route, ok
}

func Match(method string, path string) (Route, bool) {
	if !strings.HasPrefix(path, BasePath+"/") {
		return Route{}, false
	}
	candidate := strings.TrimPrefix(path, BasePath)
	for _, route := range routes {
		if route.Method == method && matchPath(route.Path, candidate) {
			return route, true
		}
	}
	return Route{}, false
}

func matchPath(template string, candidate string) bool {
	templateParts := strings.Split(strings.Trim(template, "/"), "/")
	candidateParts := strings.Split(strings.Trim(candidate, "/"), "/")
	if len(templateParts) != len(candidateParts) {
		return false
	}
	for index := range templateParts {
		if strings.HasPrefix(templateParts[index], ":") {
			if candidateParts[index] == "" {
				return false
			}
			continue
		}
		if templateParts[index] != candidateParts[index] {
			return false
		}
	}
	return true
}
