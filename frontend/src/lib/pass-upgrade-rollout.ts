// Upgrade discovery is released in every region. The server remains authoritative:
// callers only render an upgrade action when listModifyBundles returns a legal target.
export function usePassUpgradeVisible(): boolean {
  return true;
}
