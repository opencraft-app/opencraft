const LIGHTVELA_STANDALONE_MANAGEMENT_SECTIONS = new Set([
  "lightvela.hermes.skills",
  "lightvela.hermes.storage",
]);

export function isLightVelaStandaloneManagementSection(section: string): boolean {
  return LIGHTVELA_STANDALONE_MANAGEMENT_SECTIONS.has(section);
}
