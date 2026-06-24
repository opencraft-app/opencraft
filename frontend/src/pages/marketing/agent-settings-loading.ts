export function shouldShowAgentSettingsDataLoading({
  botsLoading,
  isCreating,
  visibleBotCount,
}: {
  botsLoading: boolean;
  isCreating: boolean;
  visibleBotCount: number;
}) {
  return botsLoading && !isCreating && visibleBotCount === 0;
}
