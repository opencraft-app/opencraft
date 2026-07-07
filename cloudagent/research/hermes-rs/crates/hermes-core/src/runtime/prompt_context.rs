use crate::client::Message;
use crate::context::{fit_messages_to_context, ContextConfig};
use crate::context_files::{load_default_context_files, load_workspace_context};
use crate::error::Result;
use crate::runtime::agent::AgentExecutor;
use crate::runtime::system_prompt::SystemPromptLayers;
use crate::skills::SkillInjectionPlan;
use crate::turn::TurnContext;
use crate::BehaviorVersions;

impl AgentExecutor {
    pub(crate) fn synthetic_turn_context(&self, prompt: &str) -> TurnContext {
        TurnContext {
            turn_id: "turn_direct".to_string(),
            run_id: "run_direct".to_string(),
            session_id: self.session_id.clone(),
            source: "direct".to_string(),
            prompt: prompt.to_string(),
            cwd: std::env::current_dir().unwrap_or_else(|_| ".".into()),
            versions: BehaviorVersions::default(),
            skills: Default::default(),
        }
    }

    pub(crate) async fn apply_prompt_transforms(
        &self,
        mut prompt: String,
        turn: &TurnContext,
    ) -> Result<String> {
        for hook in &self.prompt_transform_hooks {
            prompt = hook.transform_prompt(prompt, turn).await?;
        }
        Ok(prompt)
    }

    #[cfg(test)]
    pub(crate) async fn build_messages(&self) -> Result<Vec<Message>> {
        let turn = self.synthetic_turn_context("");
        self.build_messages_for_turn(&turn, None).await
    }

    pub(crate) async fn build_messages_for_turn(
        &self,
        turn: &TurnContext,
        skill_plan: Option<&SkillInjectionPlan>,
    ) -> Result<Vec<Message>> {
        let mut messages = Vec::new();

        let layers = self.build_system_prompt_layers(turn, skill_plan).await;
        let system_prompt = self.system_prompt_cache.write().await.render(&layers);
        messages.push(Message::system(system_prompt));

        if let Some(plan) = skill_plan {
            let skill_message = plan.message_text();
            if !skill_message.trim().is_empty() {
                messages.push(Message::user(format!(
                    "<turn_skill_messages>\n{}\n</turn_skill_messages>",
                    skill_message.trim()
                )));
            }
        }

        let conv = self.conversation.read().await;
        messages.extend(conv.clone());

        Ok(fit_messages_to_context(
            &messages,
            ContextConfig {
                max_context_length: self.config.context_window,
                ..ContextConfig::default()
            },
        ))
    }

    async fn build_system_prompt_layers(
        &self,
        turn: &TurnContext,
        skill_plan: Option<&SkillInjectionPlan>,
    ) -> SystemPromptLayers {
        SystemPromptLayers {
            stable: self.stable_system_prompt(),
            context: self.context_system_prompt(turn, skill_plan),
            volatile: self.volatile_system_prompt().await,
        }
    }

    fn stable_system_prompt(&self) -> String {
        if let Some(ref system) = self.config.system_prompt {
            return system.clone();
        }
        "You are an AI assistant that uses tools to help users. \
            When you need to use a tool, output your request in the following XML format:\n\
            <tool_call>{\"name\": \"tool_name\", \"arguments\": {\"arg1\": \"value1\"}}</tool_call>\n\
            If you need to use multiple tools, output them sequentially, each wrapped in its own XML tags.\n\
            After receiving tool results, continue reasoning and either call more tools or provide your final response."
            .to_string()
    }

    fn context_system_prompt(
        &self,
        turn: &TurnContext,
        skill_plan: Option<&SkillInjectionPlan>,
    ) -> String {
        let mut blocks = Vec::new();

        let context_files = self.load_context_file_prompt_for_cwd(&turn.cwd);
        if !context_files.trim().is_empty() {
            blocks.push(format!(
                "<workspace_context>\n{}\n</workspace_context>",
                context_files.trim()
            ));
        }

        if let Some(plan) = skill_plan {
            if !plan.skill_index.trim().is_empty() {
                blocks.push(plan.skill_index.trim().to_string());
            }
            let skill_prompt = plan.prompt_text();
            if !skill_prompt.trim().is_empty() {
                blocks.push(format!("<skills>\n{}\n</skills>", skill_prompt.trim()));
            }
            if !plan.inference_blocks.is_empty() {
                blocks.push(format!(
                    "<skill_inference_hints>\n{}\n</skill_inference_hints>",
                    plan.inference_blocks.join("\n\n").trim()
                ));
            }
        }

        blocks.join("\n\n")
    }

    async fn volatile_system_prompt(&self) -> String {
        let mut blocks = Vec::new();

        if let Some(memory_manager) = &self.memory_manager {
            let memory_context = memory_manager.build_memory_context(2048).await;
            let memory_context = memory_context.trim();
            if !memory_context.is_empty() {
                blocks.push(format!(
                    "<long_term_memory>\n{}\n</long_term_memory>",
                    memory_context
                ));
            }
        }

        if let Ok(note) = std::env::var("HERMES_CURRENT_TIME_NOTE") {
            let note = note.trim();
            if !note.is_empty() {
                blocks.push(format!("<runtime_context>\n{}\n</runtime_context>", note));
            }
        }

        blocks.join("\n\n")
    }

    fn load_context_file_prompt_for_cwd(&self, cwd: &std::path::Path) -> String {
        let mut blocks = Vec::new();

        let global_context = load_default_context_files();
        if !global_context.trim().is_empty() {
            blocks.push(global_context);
        }

        if let Some(workspace_context) = load_workspace_context(cwd) {
            blocks.push(workspace_context);
        }

        blocks.join("\n\n")
    }
}
