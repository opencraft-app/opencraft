## goal
Unify direct and group Hermes Bot execution-failure classification behind one bridge-domain owner.

## non_goals
- Do not expose provider diagnostics or alter provider/credit configuration.

## requirement_ids / requirement_refs / requirement_excerpt
- User request, 2026-09-16: direct Bot HTTP 402 / 401008 must surface the existing quota-friendly error code.
- User request, 2026-09-16: adapt the observed `HTTP 403: 用户额度不足, 剩余额度: $0.000000` failure to the same quota category.

## interface_refs / data_structure_refs
- `AppServerBotDomainErrorData` is the stable, safe error surface.
- Hermes direct turns carry an error message; Hosted Room turn failures carry `reason_code` plus error text.

## history_context
- Current `group-conversations.ts` contains provider-failure classification while direct Bot hardcodes `HERMES_EXECUTION_FAILED`.

## acceptance
- Both paths map HTTP 402 / 401008 to `BOT_PROVIDER_QUOTA_LIMIT`.
- A direct Bot turn containing the localized `HTTP 403` quota response maps to `BOT_PROVIDER_QUOTA_LIMIT`, before generic 403 authentication classification.
- Existing group error classifications remain unchanged.

## affected_paths
- `opencraft/plugins/lightvela-hermes/src/hermes-appserver-bridge/`
- focused failure classification tests.

## required_context
- Hermes bridge turn and Hosted Room failure projection.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `group-conversations.ts` | existing classifier | extract domain ownership |
| `bot-protocol-handler.ts` | direct failure projection | consume shared classifier |

## evidence
- Red: direct execution projection hardcoded `HERMES_EXECUTION_FAILED`, while group turns already classified the same provider failures.
- Red: the localized `HTTP 403: 用户额度不足` direct-turn regression initially returned `BOT_PROVIDER_AUTH_REQUIRED`.
- Green: shared classifier tests, direct/group Hosted Room tests, execution-error UI tests, and the 84-test Hermes plugin suite passed; plugin typecheck and boundaries check passed.
- Green: the classifier recognizes the observed localized quota phrase before the generic 403 branch; the direct-turn regression now returns `BOT_PROVIDER_QUOTA_LIMIT`.
- Current adaptation gate: the 3 focused execution-failure tests, 32-test Bot-management suite, 2 execution-error UI tests, Hermes plugin typecheck, and platform-boundary check passed.
- The current signed macOS Preview was rebuilt and restarted as PID 78704 from `release/preview`.
- Current desktop attempt did not produce runtime evidence: the rebuilt `.app` passed deep codesign verification, but electron-builder's zip stage failed while looking for the obsolete `Electron.app` path; the launched Renderer then saturated CPU before initialization and was stopped. Do not treat the earlier PID evidence as validation of this localized-403 increment.

## risks
- Never project raw upstream error details to UI.

## validation
- focused classifier, group, and direct Bot tests.

## decisions
- Provider-failure classification is bridge-domain logic, not group topology logic.

## scan_scope
- Hermes bridge failure projection.

## scan_output
- Bounded source inspection in active task turn.

## handoff
- Source complete: direct and group Hermes provider failures share stable safe Bot error codes, including the observed localized HTTP 403 quota response. Focused and service gates pass. Desktop runtime validation for this increment remains blocked by the separate Preview packaging/startup failure above. No commit or remote runtime mutation was performed.
