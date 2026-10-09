import {View, type ViewProps} from "react-native";

type TestIconProps = ViewProps & {
  color?: string;
  size?: number;
  strokeWidth?: number;
};

export default function TestLucideIcon(props: TestIconProps) {
  return <View {...props} testID={props.testID ?? "lucide-icon"} />;
}
