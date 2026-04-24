import { useCallback, useState } from "react";

const adjectivePool = ["海盐", "晨雾", "极光", "晚风", "青柚", "流云", "月砂", "松露"];
const nounPool = ["小猫", "小狐", "小鲸", "团子", "星球", "奶糖", "海螺", "气泡"];

const pick = <T,>(items: T[]) => items[Math.floor(Math.random() * items.length)] ?? items[0];

export const generateNickname = () => `${pick(adjectivePool)}${pick(nounPool)}`;

type NicknameGenerator = () => string;

const nextNickname = (currentName: string | null, generate: NicknameGenerator) => {
  let candidate = generate();

  if (!currentName) {
    return candidate;
  }

  for (let attempt = 0; attempt < 4 && candidate === currentName; attempt += 1) {
    candidate = generate();
  }

  return candidate;
};

export const useGeneratedNickname = (generate: NicknameGenerator = generateNickname) => {
  const [name, setName] = useState(() => nextNickname(null, generate));

  const refreshName = useCallback(() => {
    setName((currentName) => nextNickname(currentName, generate));
  }, [generate]);

  return {
    name,
    setName,
    refreshName,
  };
};
