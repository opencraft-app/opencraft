package persistedjson

import (
	"sort"
	"strings"
)

// DurableField 把领域契约中的 opaque-json 字段绑定到唯一写入入口。
type DurableField struct {
	Table  string
	Field  string
	Setter string
	Codec  string
}

var durableFields = []DurableField{
	{Table: "idempotency_records", Field: "response_body_json", Setter: "SetResponseBodyJSON", Codec: "EncodeScoped"},
	{Table: "reminders", Field: "anchor_message_ref_json", Setter: "SetNillableAnchorMessageRefJSON", Codec: "Encode"},
	{Table: "tasks", Field: "source_message_ref_json", Setter: "SetNillableSourceMessageRefJSON", Codec: "Encode"},
	{Table: "tencent_operations", Field: "request_snapshot_json", Setter: "SetRequestSnapshotJSON", Codec: "EncodeSnapshot"},
	{Table: "tencent_operations", Field: "result_json", Setter: "SetResultJSON", Codec: "EncodeResultSnapshot"},
}

var operationKinds = map[string]struct{}{
	"computer-bootstrap/tat.computer.bootstrap.registration": {},
	"im/im.community.ensure":                                 {},
	"im/im.identity.ensure":                                  {},
	"im/im.identity.delete":                                  {},
	"im/im.membership.ensure":                                {},
	"im/im.membership.remove":                                {},
	"im/im.topic.ensure":                                     {},
	"im/im.direct.ensure":                                    {},
	"im/im.agent.task.assigned":                              {},
	"tat/tat.computer.bootstrap.registration":                {},
	"tat/tat.computer.refresh":                               {},
	"tat/tat.computer.registration.reconcile":                {},
	"platform/platform.reminder.v1":                          {},
	"platform/platform.task.v1":                              {},
	"platform/agent.credential.rotate":                       {},
	"platform/agent.deploy":                                  {},
	"platform/agent.restart":                                 {},
	"platform/agent.start":                                   {},
	"platform/agent.stop":                                    {},
	"maintenance/im.identity.ensure":                         {},
}

var idempotencyScopes = map[string]struct{}{
	"server.create": {}, "server.update": {}, "invite.accept": {}, "join_link.accept": {},
	"channel.create": {}, "channel.update": {},
	"direct-conversation.create": {}, "direct-conversation.retry": {},
	"channel.member.add": {}, "channel.member.ensure": {}, "channel.member.remove": {},
	"member.update": {}, "member.remove": {},
	"agent.create": {}, "agent.update": {}, "agent.delete": {}, "agent.deploy": {},
	"agent.start": {}, "agent.stop": {}, "agent.restart": {},
	"agent.credential.rotate": {},
	"computer.create":         {}, "computer.refresh": {},
	"computer.runtime-credential.issue": {}, "computer.runtime-credential.rotate": {},
	"task.create": {}, "task.update": {}, "task.claim": {},
	"reminder.create": {}, "reminder.update": {}, "reminder.cancel": {},
	"thread.ensure": {}, "thread.reply": {}, "thread.reply.register": {}, "thread.read": {},
	"runtime.thread.ensure": {}, "runtime.thread.reply": {},
	"runtime.reminder.create": {}, "runtime.reminder.update": {},
}

func KnownOperation(service, kind string) bool {
	_, ok := operationKinds[strings.TrimSpace(service)+"/"+strings.TrimSpace(kind)]
	return ok
}

func KnownScope(scope string) bool {
	_, ok := idempotencyScopes[strings.TrimSpace(scope)]
	return ok
}

func OperationKinds() []string    { return keys(operationKinds) }
func IdempotencyScopes() []string { return keys(idempotencyScopes) }

func DurableFields() []DurableField {
	result := make([]DurableField, len(durableFields))
	copy(result, durableFields)
	return result
}

func keys(values map[string]struct{}) []string {
	result := make([]string, 0, len(values))
	for value := range values {
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}
