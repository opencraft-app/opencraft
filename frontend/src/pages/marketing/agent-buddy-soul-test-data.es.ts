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
    "Alguien va por la calle con ropa extravagante y cantando en voz alta. ¿Cuál es tu primera reacción?",
    "Es increíble. Ojalá pudiera sentirme así de libre.",
    "Seguramente tiene un motivo para hacerlo.",
    "Conviene respetar las normas de convivencia en público.",
  ],
  [
    "Una tarea vence mañana, la pantalla sigue en blanco y estás agotado. ¿Qué haces?",
    "Sigo adelante, aunque tenga que trasnochar, y la entrego bien.",
    "Hago lo que pueda y acepto el resultado.",
    "Quizá mañana debería fingir que estoy enfermo.",
  ],
  [
    "En una comida con más gente, normalmente…",
    "Inicio conversaciones e interactúo con los demás.",
    "Participo de vez en cuando si el momento parece adecuado.",
    "Mantengo un perfil bajo y como tranquilamente.",
  ],
  [
    "¿Qué opción describe mejor tu actitud hacia otras personas?",
    "Amable, considerado y rápido para percibir emociones.",
    "A veces atento, pero con límites claros.",
    "Racional y directo; cada persona se ocupa de sus asuntos.",
  ],
  [
    "Alguien en internet ataca tu aspecto y se burla de ti. ¿Qué ocurre por dentro?",
    "No importa. El aspecto no lo es todo.",
    "Duele un poco. ¿Quién es esa persona para juzgarme?",
    "Espera… ¿de verdad soy tan poco atractivo?",
  ],
] as const;

const PREF_COPY = [
  ["Si tuvieras que elegir una opción, ¿cuál se parece más a ti?", "Un corazón suave que avanza rápido", "Un corredor nocturno y leal", "Una pequeña chispa juguetona", "Un observador silencioso en la oscuridad"],
  ["En un equipo, ¿hacia qué papel tiendes?", "Quien rechaza la presión innecesaria", "Quien mantiene todo en movimiento", "Quien cuida el ambiente", "Quien planifica la ruta"],
  ["¿Con qué frase estás más de acuerdo?", "Todo tiene su momento", "No necesito agradar al mundo; tengo mi propio orden", "La sala necesita a alguien que la despierte", "Primero analizar; después planificar"],
  ["Cuando tienes una idea brillante, ¿qué quieres de los demás?", "Que me ayuden a llevarla a la práctica de inmediato", "Que la valoren primero; necesito ese impulso", "Que desarrollen la idea conmigo y la hagan más grande", "Que analicen si realmente es viable"],
  ["Cuando aparece la presión, ¿qué debería hacer un compañero de IA?", "Decidir y empujarme a actuar", "Calmar la emoción y reducir la presión", "Usar humor y juego para ayudarme a respirar", "Ofrecer análisis claro y evaluación de riesgos"],
  ["¿Qué historias disfrutas más?", "Romance, mitos y una nostalgia elegante", "Comedia, ideas alocadas y fantasía juguetona", "Misterio, deducción y acertijos lógicos", "Aventura, acción y exploración"],
  ["Si eligieras un compañero ideal, querrías que fuera…", "Decidido y capaz de marcar el ritmo", "Cálido, delicado y atento al estado de ánimo", "Divertido, expresivo y agradable al interactuar", "Estructurado, riguroso y claro"],
  ["Cuando estudias o trabajas, ¿cómo debería acompañarte la IA?", "Organizar el plan y guiar el proceso", "Ofrecer ánimo y consuelo", "Aportar ideas y aligerar el ambiente", "Proporcionar análisis y método"],
  ["Para descansar y entretenerte, prefieres…", "Estrategia, control y ritmo", "Experiencias cálidas y de compañía", "Comedia, azar e ideas extrañas", "Lógica, reglas y sistemas bien construidos"],
  ["Cuando un compañero de IA te da un consejo, quieres que…", "Decida y me indique directamente el siguiente paso", "Tenga en cuenta cómo me siento antes de aconsejar", "Presente la sugerencia de forma divertida", "Aporte lógica, pruebas y evaluación de riesgos"],
] as const;

export const spanishPersonalityQuestions: PersonalityQuestion[] = englishPersonalityQuestions.map(
  (question, index) => ({
    ...question,
    text: PERSONALITY_COPY[index]![0],
    options: question.options.map((option, optionIndex) => ({
      ...option,
      text: PERSONALITY_COPY[index]![optionIndex + 1]!,
    })),
  }),
);

export const spanishPrefQuestions: PrefQuestion[] = englishPrefQuestions.map((question, index) => ({
  ...question,
  text: PREF_COPY[index]![0],
  options: question.options.map((option, optionIndex) => ({
    ...option,
    text: PREF_COPY[index]![optionIndex + 1]!,
  })),
}));

const SPANISH_PERSONALITY_PHRASES: Record<string, Record<PersonalityLevel, string>> = {
  Openness: {
    low: "Prefieres estructuras conocidas y un terreno estable, ",
    mid: "Te abres a lo nuevo sin soltar del todo la prudencia, ",
    high: "Te atraen la novedad, la imaginación y las posibilidades frescas, ",
  },
  Conscientiousness: {
    low: "sueles avanzar con flexibilidad e improvisar cuando hace falta, ",
    mid: "adaptas tu forma de trabajar a cada situación, ",
    high: "tiendes a organizarte con claridad y orientación a la ejecución, ",
  },
  Extraversion: {
    low: "tu energía social es tranquila y observadora, ",
    mid: "tu ritmo social cambia según el entorno, ",
    high: "te abres a los demás y sueles aportar energía al ambiente, ",
  },
  Agreeableness: {
    low: "prefieres la franqueza y evitas el ruido innecesario, ",
    mid: "te preocupas por los demás sin perder tus límites, ",
    high: "eres amable, considerado y perceptivo con las emociones, ",
  },
  "Emotional Stability": {
    low: "y tu radar emocional es sensible, por lo que las palabras pueden afectarte profundamente.",
    mid: "y la presión puede moverte por un momento, aunque sabes recuperarte.",
    high: "y sueles afrontar la presión con calma y estabilidad racional.",
  },
};

export const SPANISH_PREF_TAG_LABELS: Record<PrefTag, string> = {
  主导性: "Liderazgo",
  安抚性: "Calma",
  活跃性: "Energía",
  玩趣性: "Juego",
  锋利性: "Agudeza",
  严谨性: "Rigor",
  浪漫性: "Romanticismo",
  行动力: "Acción",
};

export function buildSpanishQuestions(): SoulTestQuestion[] {
  return [...shuffleArray(spanishPersonalityQuestions), ...shuffleArray(spanishPrefQuestions)];
}

export function generateSpanishPersonalityProfile(answers: Record<string, string>): string {
  const phrases: string[] = [];
  for (const question of spanishPersonalityQuestions) {
    const selectedKey = answers[question.id];
    const option = question.options.find((item) => item.key === selectedKey);
    if (!option) continue;
    const phrase = SPANISH_PERSONALITY_PHRASES[question.dimension]?.[option.level];
    if (phrase) phrases.push(phrase);
  }
  return phrases.join("");
}
