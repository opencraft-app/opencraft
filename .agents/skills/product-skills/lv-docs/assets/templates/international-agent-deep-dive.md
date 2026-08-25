# International Agent Deep Dive Template

Use this asset as a structural template only.
Replace every `{{...}}` token and remove all template guidance before publishing.

## Working notes

- Canonical drafting language: `{{prompt_requested_language}}`
- Primary technical question: `{{how_or_why_question}}`
- Entities and relationships: `{{agents_models_memory_skills_runtime_or_gateways}}`
- Primary official sources: `{{upstream_docs_repositories_or_research}}`
- Technical evidence blocks: `{{tables_commands_configuration_code_outputs_or_errors_supported_by_sources}}`
- Outgoing internal links: `{{two_to_five_relevant_targets}}`
- Contextual backlink candidates: `{{one_to_three_existing_pages}}`

Do not publish the working notes as a page section.
Use `lv-seo-geo` to verify the technical query, entity relationships, routes, and contextual link graph.
Keep at least one table and use multiple focused tables when the topic has distinct dimensions, operations, states, or configuration modes.
Select only the command, configuration, code, and output blocks supported by the topic and primary sources.

## Page skeleton

# {{Question-led title naming the agent, mechanism, or comparison}}

## {{Summary or 摘要}}

**{{Answer the technical question with the central mechanism, relationship, or distinction in two to four sentences.}}**

{{Add one short paragraph only when an important version, scope, or interpretation boundary is required.}}

![{{Descriptive architecture or mechanism-image alt text}}]({{lead_image_path}})

## {{Why this question matters}}

{{Explain the practical misunderstanding or decision this page resolves.}}

## {{Definitions and architecture}}

| {{Entity or layer}} | {{Role}} | {{Mechanism or data}} | {{Boundary}} |
| --- | --- | --- | --- |
| {{Entity 1}} | {{Role 1}} | {{Mechanism 1}} | {{Boundary 1}} |
| {{Entity 2}} | {{Role 2}} | {{Mechanism 2}} | {{Boundary 2}} |
| {{Entity 3}} | {{Role 3}} | {{Mechanism 3}} | {{Boundary 3}} |

## {{Operations, states, or decision rules}}

Use this second table when operations, states, triggers, or user-visible modes need a separate comparison.
Remove it when the architecture table already explains the topic completely.

| {{Operation, state, or mode}} | {{Trigger or input}} | {{Behavior}} | {{Result or boundary}} |
| --- | --- | --- | --- |
| {{Item 1}} | {{Trigger 1}} | {{Behavior 1}} | {{Result 1}} |
| {{Item 2}} | {{Trigger 2}} | {{Behavior 2}} | {{Result 2}} |
| {{Item 3}} | {{Trigger 3}} | {{Behavior 3}} | {{Result 3}} |

## {{How the mechanism works}}

### {{Stage or layer 1}}

{{Explain the input, process, output, and source-backed implementation detail.}}

### {{Stage or layer 2}}

{{Explain the input, process, output, and source-backed implementation detail.}}

### {{Stage or layer 3}}

{{Explain the input, process, output, and source-backed implementation detail.}}

## {{Commands, configuration, and technical evidence}}

Keep only the block types that help explain the mechanism.
Introduce every block and explain the important result, field, or failure state immediately afterward.

### {{Markdown record or structured entry}}

```md
{{verified_markdown_record_or_file_example}}
```

### {{Slash commands}}

```text
/{{verified_command}} {{arguments}}
/{{verified_command}} {{subcommand}} {{identifier}}
```

### {{CLI commands}}

```bash
{{verified_cli_command}}
{{verified_cli_command_with_option}}
```

### {{Configuration example}}

```yaml
{{verified_configuration_key}}:
  {{verified_nested_setting}}: {{example_value}}
```

### {{Structured response or state}}

```json
{
  "{{verified_field}}": "{{example_value}}",
  "{{verified_status_field}}": "{{example_status}}"
}
```

### {{Expected output or error}}

```text
{{verified_user_visible_output_or_error_message}}
```

## {{Concrete example or sequence}}

1. {{Observable event or user action.}}
2. {{Agent or runtime operation.}}
3. {{Stored state, tool result, or user-visible outcome.}}

## {{Boundaries and failure modes}}

{{Explain what the mechanism does not do, what can become stale or unavailable, and how readers can verify behavior.}}

## {{LightVela's approach or LightVela 的做法}}

{{Clearly separate verified LightVela product behavior from upstream Hermes or third-party mechanisms.}}

## {{FAQ or 常见问题}}

Include two to four concise questions only when they improve answer extraction or resolve a common technical misunderstanding.

### {{High-intent technical question}}

{{Concise direct answer with a contextual internal link when useful.}}

## {{Key takeaways or 小结}}

- {{Central mechanism or distinction.}}
- {{Most important practical consequence.}}
- {{Critical limitation or verification step.}}
