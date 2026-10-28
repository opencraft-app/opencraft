/** Version and build identifiers wrap only after "." or "-". */
export function SettingsIdentifier({ value }: { value: string }) {
  const parts = value.split(/([.-])/);
  return <span className="settings-identifier">{parts.map((part, index) => (
    part === "." || part === "-" ? <span key={index}>{part}<wbr /></span> : <span key={index}>{part}</span>
  ))}</span>;
}
