import type { DataMode } from "@/domain/types";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";

interface ScenarioSwitcherProps {
  value: DataMode;
  onChange: (value: DataMode) => void;
}

export const ScenarioSwitcher = ({ value, onChange }: ScenarioSwitcherProps) => {
  return (
    <div className="flex items-center gap-2">
      <Label className="text-xs uppercase tracking-[0.08em] text-[var(--text-tertiary)]">状态场景</Label>
      <Select value={value} onValueChange={(next) => onChange(next as DataMode)}>
        <SelectTrigger className="w-32">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="live">实时</SelectItem>
          <SelectItem value="empty">空态</SelectItem>
          <SelectItem value="error">错误</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
};
