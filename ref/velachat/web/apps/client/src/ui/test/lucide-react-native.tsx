import type {ComponentType} from "react";
import {View, type ViewProps} from "react-native";

type TestIconProps = ViewProps & {
  color?: string;
  size?: number;
  strokeWidth?: number;
};

function icon(name: string): ComponentType<TestIconProps> {
  return function TestIcon(props: TestIconProps) {
    return <View {...props} testID={props.testID ?? `lucide-${name}`} />;
  };
}

export const ArrowLeft = icon("arrow-left");
export const AtSign = icon("at-sign");
export const Bot = icon("bot");
export const Hash = icon("hash");
export const Image = icon("image");
export const ListChecks = icon("list-checks");
export const LogOut = icon("log-out");
export const MessageCircle = icon("message-circle");
export const Monitor = icon("monitor");
export const Paperclip = icon("paperclip");
export const Pencil = icon("pencil");
export const Plus = icon("plus");
export const Search = icon("search");
export const Send = icon("send");
export const UsersRound = icon("users-round");
