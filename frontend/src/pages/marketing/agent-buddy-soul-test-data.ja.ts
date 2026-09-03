import type {
  PersonalityLevel,
  PersonalityQuestion,
  PrefQuestion,
  PrefTag,
  SoulTestQuestion,
} from "@/pages/marketing/agent-buddy-soul-test-data";
import { shuffleArray } from "@/pages/marketing/agent-buddy-soul-test-data";
import {
  englishPersonalityQuestions,
  englishPrefQuestions,
} from "@/pages/marketing/agent-buddy-soul-test-data.en";

const PERSONALITY_COPY = [
  [
    "派手な服装で、大声で歌いながら歩いている人を見かけました。最初にどう思いますか？",
    "すごい。自分もあれくらい自由でいられたらいいな。",
    "きっと何か事情があるのだろう。",
    "公共の場では、周りへの配慮も必要だと思う。",
  ],
  [
    "締め切りは明日。でも画面は真っ白で、もうへとへとです。どうしますか？",
    "徹夜になっても踏ん張って、きちんと仕上げる。",
    "できるところまで進めて、結果を受け入れる。",
    "明日は体調不良ということにしようかな。",
  ],
  [
    "何人かで食事をするとき、あなたは普段どうしていますか？",
    "自分から話題を振って、みんなと会話する。",
    "タイミングが合えば、ときどき会話に加わる。",
    "目立たず、静かに食事を楽しむ。",
  ],
  [
    "人との接し方について、最も近いものはどれですか？",
    "穏やかで思いやりがあり、相手の気持ちによく気づく。",
    "気にかけることはあるが、境界線はきちんと引く。",
    "合理的で率直。人のことは人のことだと思う。",
  ],
  [
    "ネットで容姿をけなされ、からかわれました。心の中ではどう感じますか？",
    "気にしない。見た目がすべてではない。",
    "少し傷つく。どうしてあの人に決めつけられなきゃいけないの？",
    "待って……自分って本当に格好悪いのかな？",
  ],
] as const;

const PREF_COPY = [
  ["一つだけ選ぶなら、どれが最も自分に近いですか？", "優しくても、すぐに動き出す心", "誠実な夜のランナー", "遊び心のある小さな火花", "暗闇で静かに見守る観察者"],
  ["チームでは、どんな役回りになりがちですか？", "余計なプレッシャーをはね返す人", "物事を前へ進め続ける人", "場の空気を整える人", "進む道筋を考える人"],
  ["最も共感する言葉はどれですか？", "何事にも、ちょうどいいタイミングがある", "世間に好かれなくてもいい。自分には自分の秩序がある", "場を盛り上げる人が一人は必要だ", "まず分析、次に計画"],
  ["すばらしいアイデアを思いついたとき、周りに何を求めますか？", "すぐ形にするのを手伝ってほしい", "まず褒めてほしい。勢いをつけたい", "一緒に発想を広げて、もっと面白くしてほしい", "本当に実現できるか分析してほしい"],
  ["プレッシャーを感じたとき、AIの相棒に何をしてほしいですか？", "判断して、行動へ引っ張ってほしい", "気持ちを落ち着かせて、負担を軽くしてほしい", "ユーモアや遊びで、ひと息つかせてほしい", "明確な分析とリスク評価を示してほしい"],
  ["どんな物語が一番好きですか？", "恋愛、神話、上品な憧れ", "コメディ、大胆な発想、愉快な空想", "ミステリー、推理、論理パズル", "冒険、アクション、探索"],
  ["理想の相棒を選ぶなら、どんな存在がいいですか？", "決断力があり、リズムを作ってくれる", "温かく繊細で、気分の変化に気づいてくれる", "面白くて生き生きとして、一緒にいて楽しい", "筋道立っていて、厳密で分かりやすい"],
  ["勉強や仕事をするとき、AIにどう寄り添ってほしいですか？", "計画を組み、進め方を導いてほしい", "励まし、安心させてほしい", "アイデアを出し、場を明るくしてほしい", "分析と方法を示してほしい"],
  ["休憩や娯楽では、どれを好みますか？", "戦略、コントロール、テンポ", "温かく、寄り添ってくれる体験", "笑い、偶然性、突飛なアイデア", "論理、ルール、緻密に作られた仕組み"],
  ["AIの相棒から助言をもらうなら、どうしてほしいですか？", "判断して、次にやることをはっきり伝えてほしい", "助言の前に、まず気持ちを気にかけてほしい", "楽しく、またはユーモアを交えて提案してほしい", "論理、根拠、リスク評価を示してほしい"],
] as const;

export const japanesePersonalityQuestions: PersonalityQuestion[] = englishPersonalityQuestions.map(
  (question, index) => ({
    ...question,
    text: PERSONALITY_COPY[index]![0],
    options: question.options.map((option, optionIndex) => ({
      ...option,
      text: PERSONALITY_COPY[index]![optionIndex + 1]!,
    })),
  }),
);

export const japanesePrefQuestions: PrefQuestion[] = englishPrefQuestions.map((question, index) => ({
  ...question,
  text: PREF_COPY[index]![0],
  options: question.options.map((option, optionIndex) => ({
    ...option,
    text: PREF_COPY[index]![optionIndex + 1]!,
  })),
}));

const JAPANESE_PERSONALITY_PHRASES: Record<string, Record<PersonalityLevel, string>> = {
  Openness: {
    low: "慣れ親しんだ枠組みや安定した環境を好み、",
    mid: "慎重さを保ちながら、新しいものも柔軟に受け入れ、",
    high: "新しさや想像力、未知の可能性に強く引かれ、",
  },
  Conscientiousness: {
    low: "肩の力を抜き、必要に応じて即興で進める傾向があり、",
    mid: "状況に合わせて仕事の進め方を調整でき、",
    high: "物事を整理し、明確に実行へ移すことを得意とし、",
  },
  Extraversion: {
    low: "人との場では静かに周囲を観察し、",
    mid: "環境に合わせて人との距離感を変え、",
    high: "人に対して開かれていて、場に活気をもたらし、",
  },
  Agreeableness: {
    low: "率直さを好み、余計な駆け引きを避け、",
    mid: "自分の境界線を守りながら、ほどよく相手を気遣い、",
    high: "穏やかで思いやりがあり、感情の変化にもよく気づき、",
  },
  "Emotional Stability": {
    low: "感情のアンテナが鋭いため、言葉を深く受け止めることがあります。",
    mid: "プレッシャーに一度揺れても、自分のペースを取り戻せます。",
    high: "プレッシャーにも落ち着いて、理性的に向き合えます。",
  },
};

export const JAPANESE_PREF_TAG_LABELS: Record<PrefTag, string> = {
  主导性: "主導力",
  安抚性: "安心感",
  活跃性: "活発さ",
  玩趣性: "遊び心",
  锋利性: "鋭さ",
  严谨性: "緻密さ",
  浪漫性: "ロマン性",
  行动力: "行動力",
};

export function buildJapaneseQuestions(): SoulTestQuestion[] {
  return [...shuffleArray(japanesePersonalityQuestions), ...shuffleArray(japanesePrefQuestions)];
}

export function generateJapanesePersonalityProfile(answers: Record<string, string>): string {
  const phrases: string[] = [];
  for (const question of japanesePersonalityQuestions) {
    const selectedKey = answers[question.id];
    const option = question.options.find((item) => item.key === selectedKey);
    if (!option) continue;
    const phrase = JAPANESE_PERSONALITY_PHRASES[question.dimension]?.[option.level];
    if (phrase) phrases.push(phrase);
  }
  return phrases.join("");
}
