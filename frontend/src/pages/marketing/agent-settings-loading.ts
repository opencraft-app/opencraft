export function shouldShowAgentSettingsDataLoading({
  botsLoading,
  passesLoading,
  isCreating,
  visibleBotCount,
}: {
  botsLoading: boolean;
  passesLoading: boolean;
  isCreating: boolean;
  visibleBotCount: number;
}) {
  return (botsLoading || passesLoading) && !isCreating && visibleBotCount === 0;
}
