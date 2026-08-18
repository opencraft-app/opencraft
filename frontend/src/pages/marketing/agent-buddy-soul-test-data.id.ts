import type {
  PersonalityQuestion,
  PrefQuestion,
  PrefTag,
  PersonalityLevel,
} from "@/pages/marketing/agent-buddy-soul-test-data";
import {
  shuffleArray,
  type SoulTestQuestion,
} from "@/pages/marketing/agent-buddy-soul-test-data";

/**
 * 印尼语 Soul 测试题库。
 *
 * 设计约定（由 agent-buddy-soul-test-data.id.test.ts 锁定）：
 * - 题目 `id`、选项 `key`、`primary`/`secondary` 标签与英文题库**逐条一致**，
 *   仅文案本地化。因此计分与人设匹配可直接复用英文实现
 *   （`calculateEnglishPrefScores` / `calculateEnglishMatchedSoul` /
 *   `categorizeEnglishPrefScores`），避免两套算法产生漂移。
 * - `dimension` 沿用英文键名，它只作为 `indonesianPersonalityPhrases` 的查表键，
 *   不在界面上展示。
 */
export const indonesianPersonalityQuestions: PersonalityQuestion[] = [
  {
    id: "p1",
    dimension: "Openness",
    text: "Ada orang di jalan berpakaian sangat mencolok dan bernyanyi dengan lantang. Apa reaksi pertama Anda?",
    options: [
      { key: "A", text: "Keren sekali. Saya juga ingin sebebas itu.", level: "high", score: 2 },
      { key: "B", text: "Mungkin ada alasan di balik tindakannya.", level: "mid", score: 1 },
      { key: "C", text: "Orang sebaiknya tetap memperhatikan kesopanan di ruang publik.", level: "low", score: 0 },
    ],
  },
  {
    id: "p2",
    dimension: "Conscientiousness",
    text: "Tugas harus dikumpulkan besok, layar Anda masih kosong, dan Anda sudah sangat lelah. Apa yang Anda lakukan?",
    options: [
      { key: "A", text: "Tetap saya kerjakan, bahkan sampai lembur, agar hasilnya benar.", level: "high", score: 2 },
      { key: "B", text: "Kerjakan sebisanya lalu terima apa pun hasilnya.", level: "mid", score: 1 },
      { key: "C", text: "Mungkin besok saya pura-pura sakit saja.", level: "low", score: 0 },
    ],
  },
  {
    id: "p3",
    dimension: "Extraversion",
    text: "Saat makan bersama, Anda biasanya...",
    options: [
      { key: "A", text: "Memulai percakapan dan aktif berinteraksi.", level: "high", score: 2 },
      { key: "B", text: "Ikut menyahut sesekali kalau waktunya terasa tepat.", level: "mid", score: 1 },
      { key: "C", text: "Bersikap santai dan makan dengan tenang.", level: "low", score: 0 },
    ],
  },
  {
    id: "p4",
    dimension: "Agreeableness",
    text: "Mana yang paling menggambarkan sikap Anda terhadap orang lain?",
    options: [
      { key: "A", text: "Lembut, penuh pertimbangan, dan cepat menangkap perasaan orang.", level: "high", score: 2 },
      { key: "B", text: "Kadang peduli, tetapi dengan batas yang jelas.", level: "mid", score: 1 },
      { key: "C", text: "Rasional dan lugas. Urusan orang lain adalah urusan mereka.", level: "low", score: 0 },
    ],
  },
  {
    id: "p5",
    dimension: "Emotional Stability",
    text: "Seseorang di internet menyerang penampilan Anda dan menertawakannya. Apa yang terjadi di dalam diri Anda?",
    options: [
      { key: "A", text: "Tidak masalah. Penampilan bukan segalanya.", level: "high", score: 2 },
      { key: "B", text: "Sedikit sakit hati. Memangnya dia siapa sampai menilai saya?", level: "mid", score: 1 },
      { key: "C", text: "Tunggu... apa saya benar-benar seburuk itu?", level: "low", score: 0 },
    ],
  },
];

/**
 * 五维话术，按顺序拼接成一段自我描述。
 * 前四维以逗号结尾、末维以 `dan` 收束，保证拼接后是通顺的印尼语长句。
 */
const indonesianPersonalityPhrases: Record<string, Record<PersonalityLevel, string>> = {
  Openness: {
    low: "Anda cenderung menyukai struktur yang sudah dikenal dan pijakan yang stabil, ",
    mid: "Anda terbuka pada hal baru sambil tetap berhati-hati, ",
    high: "Anda tertarik pada hal baru, imajinasi, dan kemungkinan yang segar, ",
  },
  Conscientiousness: {
    low: "cenderung bergerak santai dan berimprovisasi sesuai kebutuhan, ",
    mid: "dapat menyesuaikan gaya kerja dengan situasi yang dihadapi, ",
    high: "umumnya teratur, jelas, dan berorientasi pada eksekusi, ",
  },
  Extraversion: {
    low: "energi sosial Anda tenang dan penuh pengamatan, ",
    mid: "ritme sosial Anda berubah mengikuti lingkungan, ",
    high: "Anda terbuka secara sosial dan sering menghidupkan suasana, ",
  },
  Agreeableness: {
    low: "Anda lebih menyukai keterusterangan dan tidak suka keriuhan yang tak perlu, ",
    mid: "Anda peduli secara terukur sambil tetap menjaga batas, ",
    high: "Anda lembut, penuh pertimbangan, dan peka secara emosional, ",
  },
  "Emotional Stability": {
    low: "dan radar emosi Anda peka, sehingga ucapan orang bisa terasa dalam.",
    mid: "dan tekanan mungkin mengguncang Anda sesaat, tetapi Anda bisa pulih.",
    high: "dan Anda biasanya menghadapi tekanan dengan tenang dan rasional.",
  },
};

export const indonesianPrefQuestions: PrefQuestion[] = [
  {
    id: "q1",
    text: "Kalau harus memilih satu, mana yang paling terasa seperti Anda?",
    options: [
      { key: "A", text: "Hati yang lembut tetapi bergerak cepat", primary: "主导性", secondary: "行动力" },
      { key: "B", text: "Pelari malam yang setia", primary: "安抚性", secondary: "浪漫性" },
      { key: "C", text: "Percikan kecil yang suka bermain", primary: "玩趣性", secondary: "活跃性" },
      { key: "D", text: "Pengamat sunyi dalam kegelapan", primary: "严谨性", secondary: "锋利性" },
    ],
  },
  {
    id: "q2",
    text: "Dalam sebuah tim, Anda cenderung mengambil peran apa?",
    options: [
      { key: "A", text: "Orang yang menolak tekanan yang tidak perlu", primary: "主导性", secondary: "行动力" },
      { key: "B", text: "Orang yang menjaga semuanya tetap berjalan", primary: "安抚性", secondary: "浪漫性" },
      { key: "C", text: "Orang yang mengatur suasana", primary: "玩趣性", secondary: "活跃性" },
      { key: "D", text: "Orang yang merancang rutenya", primary: "严谨性", secondary: "锋利性" },
    ],
  },
  {
    id: "q3",
    text: "Kalimat mana yang paling Anda setujui?",
    options: [
      { key: "A", text: "Segala sesuatu punya waktunya sendiri.", primary: "主导性", secondary: "锋利性" },
      { key: "B", text: "Saya tak perlu menyenangkan dunia; saya punya tatanan sendiri.", primary: "安抚性", secondary: "浪漫性" },
      { key: "C", text: "Ruangan ini butuh seseorang yang bisa membangunkannya.", primary: "活跃性", secondary: "玩趣性" },
      { key: "D", text: "Analisis dulu. Baru menyusun rencana.", primary: "严谨性", secondary: "行动力" },
    ],
  },
  {
    id: "q4",
    text: "Ketika Anda punya ide cemerlang, apa yang Anda harapkan dari orang lain?",
    options: [
      { key: "A", text: "Bantu saya mewujudkannya sekarang.", primary: "行动力", secondary: "主导性" },
      { key: "B", text: "Puji dulu idenya. Saya butuh dorongan itu.", primary: "安抚性", secondary: "浪漫性" },
      { key: "C", text: "Curah gagasan bersama saya dan buat idenya lebih besar.", primary: "玩趣性", secondary: "活跃性" },
      { key: "D", text: "Analisis apakah idenya benar-benar bisa dijalankan.", primary: "严谨性", secondary: "锋利性" },
    ],
  },
  {
    id: "q5",
    text: "Saat tekanan datang, apa yang sebaiknya dilakukan pendamping AI?",
    options: [
      { key: "A", text: "Ambil keputusan dan tarik saya untuk bertindak.", primary: "主导性", secondary: "行动力" },
      { key: "B", text: "Tenangkan emosinya dan turunkan tekanannya.", primary: "安抚性", secondary: "浪漫性" },
      { key: "C", text: "Pakai humor dan sisi jenaka agar saya bisa bernapas.", primary: "玩趣性", secondary: "活跃性" },
      { key: "D", text: "Berikan analisis dan penilaian risiko yang jelas.", primary: "严谨性", secondary: "锋利性" },
    ],
  },
  {
    id: "q6",
    text: "Cerita seperti apa yang paling Anda nikmati?",
    options: [
      { key: "A", text: "Roman, mitos, kerinduan yang syahdu", primary: "安抚性", secondary: "浪漫性" },
      { key: "B", text: "Komedi, ide gila, fantasi yang jenaka", primary: "玩趣性", secondary: "活跃性" },
      { key: "C", text: "Misteri, deduksi, teka-teki logika", primary: "锋利性", secondary: "严谨性" },
      { key: "D", text: "Petualangan, aksi, penjelajahan", primary: "行动力", secondary: "主导性" },
    ],
  },
  {
    id: "q7",
    text: "Kalau memilih pendamping ideal, Anda ingin dia...",
    options: [
      { key: "A", text: "Tegas dan mampu memimpin ritmenya.", primary: "主导性", secondary: "行动力" },
      { key: "B", text: "Hangat, halus, dan peka pada suasana hati.", primary: "安抚性", secondary: "浪漫性" },
      { key: "C", text: "Lucu, hidup, dan menyenangkan untuk diajak berinteraksi.", primary: "玩趣性", secondary: "活跃性" },
      { key: "D", text: "Terstruktur, teliti, dan jelas.", primary: "严谨性", secondary: "锋利性" },
    ],
  },
  {
    id: "q8",
    text: "Ketika Anda belajar atau bekerja, bagaimana AI sebaiknya mendampingi?",
    options: [
      { key: "A", text: "Menyusun rencananya dan memandu prosesnya.", primary: "主导性", secondary: "行动力" },
      { key: "B", text: "Memberi dorongan semangat dan penghiburan.", primary: "安抚性", secondary: "浪漫性" },
      { key: "C", text: "Membawa ide dan meringankan suasananya.", primary: "玩趣性", secondary: "活跃性" },
      { key: "D", text: "Menyediakan analisis dan metodenya.", primary: "严谨性", secondary: "锋利性" },
    ],
  },
  {
    id: "q9",
    text: "Untuk beristirahat dan bersenang-senang, Anda lebih suka...",
    options: [
      { key: "A", text: "Strategi, kendali, dan ritme.", primary: "主导性", secondary: "锋利性" },
      { key: "B", text: "Pengalaman yang hangat dan terasa seperti ditemani.", primary: "安抚性", secondary: "浪漫性" },
      { key: "C", text: "Komedi, hal acak, dan gagasan yang aneh.", primary: "玩趣性", secondary: "活跃性" },
      { key: "D", text: "Logika, aturan, dan sistem yang dirancang cermat.", primary: "严谨性", secondary: "行动力" },
    ],
  },
  {
    id: "q10",
    text: "Ketika pendamping AI memberi saran, Anda ingin ia...",
    options: [
      { key: "A", text: "Memutuskan dan langsung memberi tahu langkah berikutnya.", primary: "主导性", secondary: "行动力" },
      { key: "B", text: "Memperhatikan perasaan saya sebelum memberi saran.", primary: "安抚性", secondary: "浪漫性" },
      { key: "C", text: "Menyampaikan sarannya dengan cara yang jenaka atau lucu.", primary: "玩趣性", secondary: "活跃性" },
      { key: "D", text: "Memberi logika, bukti, dan penilaian risikonya.", primary: "严谨性", secondary: "锋利性" },
    ],
  },
];

export const INDONESIAN_PREF_TAG_LABELS: Record<PrefTag, string> = {
  主导性: "Kepemimpinan",
  安抚性: "Menenangkan",
  活跃性: "Keaktifan",
  玩趣性: "Kejenakaan",
  锋利性: "Ketajaman",
  严谨性: "Ketelitian",
  浪漫性: "Romantisme",
  行动力: "Daya Tindak",
};

export function buildIndonesianQuestions(): SoulTestQuestion[] {
  return [...shuffleArray(indonesianPersonalityQuestions), ...shuffleArray(indonesianPrefQuestions)];
}

export function generateIndonesianPersonalityProfile(answers: Record<string, string>): string {
  const phrases: string[] = [];

  for (const question of indonesianPersonalityQuestions) {
    const selectedKey = answers[question.id];
    if (!selectedKey) continue;
    const option = question.options.find((item) => item.key === selectedKey);
    if (!option) continue;
    const phrase = indonesianPersonalityPhrases[question.dimension]?.[option.level];
    if (phrase) phrases.push(phrase);
  }

  return phrases.join("");
}
