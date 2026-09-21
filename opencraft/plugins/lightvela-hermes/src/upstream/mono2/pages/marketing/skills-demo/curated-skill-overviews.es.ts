// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import type { CuratedSkillOverview } from "./curated-skill-overviews";

type SpanishSkillDefinition = {
  name: string;
  purpose: string;
  input: string;
  outcome: string;
  prompt: string;
};

function makeOverview(definition: SpanishSkillDefinition): CuratedSkillOverview {
  const { name, purpose, input, outcome, prompt } = definition;
  return {
    overview: [
      `${name} ayuda a ${purpose}.`,
      `Proporciona ${input}. La habilidad organiza el trabajo y te ayuda a obtener ${outcome}.`,
    ],
    whoShouldUse: [
      { title: "Profesionales", description: `Personas que necesitan ${purpose} con un proceso claro.` },
      { title: "Equipos operativos", description: `Equipos que quieren convertir ${input} en resultados utilizables.` },
      { title: "Responsables de decisiones", description: `Personas que necesitan revisar ${outcome} antes de actuar.` },
    ],
    problemsItSolves: [
      { title: "Trabajo disperso", description: "Reúne el contexto relevante y evita perder pasos importantes." },
      { title: "Resultados poco claros", description: `Estructura el proceso para producir ${outcome}.` },
      { title: "Tareas repetitivas", description: "Ofrece un flujo reutilizable que puede aplicarse en futuras consultas." },
    ],
    keyCapabilities: [
      { title: "Análisis estructurado", description: `Descompone el trabajo necesario para ${purpose}.` },
      { title: "Guía contextual", description: `Adapta las recomendaciones a ${input}.` },
      { title: "Resultados claros", description: `Presenta ${outcome} de forma fácil de revisar.` },
      { title: "Flujo repetible", description: "Mantiene un proceso consistente desde la entrada hasta la entrega." },
    ],
    basicUsage: `Indica ${input}, añade las restricciones importantes y explica qué decisión o entrega necesitas. Revisa el resultado de ${name} antes de aplicarlo.`,
    examplePrompt: prompt,
  };
}

const DEFINITIONS: Record<string, SpanishSkillDefinition> = {
  "mattpocock/skills/teach": {
    name: "Teach", purpose: "crear un espacio de aprendizaje persistente con lecciones breves y basadas en fuentes", input: "el tema, tu objetivo de aprendizaje, preferencias y restricciones", outcome: "un curso continuo con fuentes, práctica y registros de progreso", prompt: "Enséñame los fundamentos de este código mediante lecciones breves. Primero pregunta por mi objetivo, reúne fuentes fiables y registra las fuentes antes de escribir la primera lección.",
  },
  "mattpocock/skills/grill-me": {
    name: "Grill Me", purpose: "poner a prueba un plan o diseño mediante preguntas sistemáticas", input: "el plan, la idea o el diseño y las decisiones ya tomadas", outcome: "riesgos, supuestos y criterios de aceptación más claros", prompt: "Hazme preguntas sobre este plan, una por una, sigue las respuestas importantes y continúa hasta que el alcance, los riesgos y los criterios de aceptación estén claros.",
  },
  "flowkit-labs/skills/reddit-automation": {
    name: "Reddit Automation", purpose: "encontrar conversaciones de Reddit donde un producto puede ayudar de verdad", input: "el contexto del producto, la audiencia, las comunidades y la ayuda que puedes ofrecer", outcome: "hilos relevantes y borradores de respuesta útiles con afiliación transparente", prompt: "Encuentra hilos recientes de Reddit donde nuestro producto pueda ayudar. Explica por qué son relevantes, redacta respuestas útiles con afiliación transparente y espera mi revisión antes de publicar.",
  },
  "charon-fan/agent-playbook/self-improving-agent": {
    name: "Self-Improving Agent", purpose: "aprender de resultados, errores y correcciones de ejecuciones anteriores", input: "el contexto de la ejecución, lo que ocurrió y los comentarios recibidos", outcome: "una mejora limitada, validable y reutilizable", prompt: "Revisa esta ejecución fallida, identifica la lección reutilizable y propón cómo validarla antes de aplicarla en el próximo intento.",
  },
  "vercel-labs/skills/find-skills": {
    name: "Find Skills", purpose: "encontrar habilidades especializadas para una tarea concreta", input: "la tarea, el dominio y las restricciones de la capacidad que buscas", outcome: "una lista breve de habilidades relevantes con orientación de instalación", prompt: "Encuentra una habilidad para comparar páginas de precios de competidores y resumir los cambios cada semana.",
  },
  "steipete/clawdis/weather": {
    name: "Weather", purpose: "consultar el tiempo actual y la previsión de una ubicación", input: "la ciudad, región, aeropuerto o coordenadas y el intervalo de fechas", outcome: "condiciones meteorológicas útiles para planificar", prompt: "¿Qué tiempo hará en Kioto de viernes a domingo y qué tarde conviene más para un paseo al aire libre?",
  },
  "juliusbrussee/caveman/caveman": {
    name: "Caveman", purpose: "reducir respuestas extensas sin perder la información técnica necesaria", input: "la petición normal y el nivel de concisión deseado", outcome: "una respuesta directa, compacta y accionable", prompt: "Usa un nivel de concisión alto: explica el fallo de despliegue, la causa probable y los tres próximos comandos.",
  },
  "mattpocock/skills/to-issues": {
    name: "To Issues", purpose: "convertir un plan o PRD en incidencias ejecutables por partes", input: "el documento de origen, el repositorio y las reglas del gestor de incidencias", outcome: "incidencias con alcance, criterios de aceptación y dependencias", prompt: "Convierte este PRD aprobado en incidencias verticales revisables e indica sus dependencias antes de publicarlas.",
  },
  "roin-orca/skills/simple": {
    name: "Simple", purpose: "aclarar una idea y comparar opciones antes de programar", input: "el objetivo, los usuarios, las restricciones y el contexto técnico disponible", outcome: "una dirección aprobada con decisiones y compensaciones explícitas", prompt: "Ayúdame a aclarar esta función, compara dos enfoques viables y registra la opción elegida antes de implementar.",
  },
  "gracefullight/stock-checker/stock-analysis": {
    name: "Stock Analysis", purpose: "analizar una acción con indicadores fundamentales y de mercado", input: "el símbolo, mercado, periodo y criterios de análisis", outcome: "un informe de inversión estructurado con riesgos visibles", prompt: "Analiza esta acción con fundamentos, valoración, tendencia y riesgos; separa hechos de inferencias.",
  },
  "molezzz/openclaw-stock-skill/akshare-stock": {
    name: "AKShare Stock", purpose: "consultar y analizar datos financieros disponibles mediante AKShare", input: "el activo, el mercado chino y las métricas o fechas de interés", outcome: "datos organizados y una lectura financiera verificable", prompt: "Obtén los datos recientes de esta empresa y resume valoración, resultados y evolución del precio.",
  },
  "anthropics/financial-services-plugins/earnings-analysis": {
    name: "Earnings Analysis", purpose: "examinar resultados trimestrales, orientación y señales de negocio", input: "el informe de resultados, la transcripción o los documentos financieros", outcome: "un análisis de sorpresas, tendencias, riesgos y preguntas pendientes", prompt: "Analiza estos resultados trimestrales y destaca cambios frente al trimestre anterior y a las previsiones.",
  },
  "okx/agent-skills/okx-sentiment-tracker": {
    name: "OKX Sentiment Tracker", purpose: "seguir señales de sentimiento relevantes para mercados de criptoactivos", input: "los activos, fuentes, periodo y umbrales que quieres vigilar", outcome: "un resumen de sentimiento con señales y contexto de mercado", prompt: "Sigue el sentimiento de BTC y ETH durante siete días y avísame de cambios bruscos con sus posibles causas.",
  },
  "phuryn/pm-skills/sentiment-analysis": {
    name: "Sentiment Analysis", purpose: "clasificar opiniones y descubrir temas recurrentes en texto", input: "comentarios, reseñas, entrevistas o mensajes de usuarios", outcome: "temas, intensidad emocional y ejemplos representativos", prompt: "Analiza estas reseñas, agrupa los temas y distingue problemas urgentes de preferencias menores.",
  },
  "personamanagmentlayer/pcl/finance-expert": {
    name: "Finance Expert", purpose: "razonar sobre finanzas con supuestos y riesgos explícitos", input: "la decisión financiera, los datos disponibles y el horizonte temporal", outcome: "un análisis financiero comprensible con escenarios y límites", prompt: "Compara estas dos opciones financieras, muestra los supuestos y crea escenarios conservador, base y optimista.",
  },
  "coreyhaines31/marketingskills/content-strategy": {
    name: "Content Strategy", purpose: "diseñar una estrategia de contenidos conectada con objetivos de negocio", input: "la audiencia, el producto, los canales, los objetivos y el contenido existente", outcome: "pilares, prioridades, calendario y métricas de contenido", prompt: "Crea una estrategia trimestral de contenidos para este producto con pilares, formatos, distribución y métricas.",
  },
  "coreyhaines31/marketingskills/social-content": {
    name: "Social Content", purpose: "planificar y redactar contenido adaptado a redes sociales", input: "la marca, la audiencia, la plataforma, el tono y la campaña", outcome: "publicaciones claras con variantes y llamadas a la acción", prompt: "Convierte este lanzamiento en una semana de publicaciones para LinkedIn y X sin repetir el mismo texto.",
  },
  "composiohq/awesome-claude-skills/content-research-writer": {
    name: "Content Research Writer", purpose: "investigar un tema y convertir las fuentes en un borrador sólido", input: "el tema, la audiencia, las fuentes y los requisitos editoriales", outcome: "un texto estructurado con afirmaciones respaldadas", prompt: "Investiga este tema y prepara un artículo para desarrolladores; indica las fuentes y las afirmaciones que requieren revisión.",
  },
  "googleworkspace/cli/persona-content-creator": {
    name: "Persona Content Creator", purpose: "crear contenido consistente con una persona y una voz definidas", input: "la persona, el objetivo, el canal, el tono y el material de referencia", outcome: "contenido alineado con la audiencia y la identidad indicada", prompt: "Redacta este anuncio para una persona técnica y escéptica, con un tono directo y sin exageraciones.",
  },
  "resciencelab/opc-skills/seo-geo": {
    name: "SEO GEO", purpose: "auditar y mejorar la visibilidad en buscadores y respuestas generativas", input: "la URL, las páginas, palabras clave, competidores y objetivos", outcome: "prioridades técnicas, editoriales y de datos estructurados", prompt: "Audita esta página de precios para SEO y GEO y prioriza mejoras de estructura, citas y JSON-LD.",
  },
  "mattpocock/skills/edit-article": {
    name: "Edit Article", purpose: "editar artículos para mejorar claridad, estructura y precisión", input: "el borrador, la audiencia, el tono y las restricciones de edición", outcome: "un artículo más claro que conserva las afirmaciones originales", prompt: "Propón primero un orden mejor para las secciones y después edita el artículo sin cambiar sus afirmaciones técnicas.",
  },
  "karpathy/nanochat/read-arxiv-paper": {
    name: "Read arXiv Paper", purpose: "leer y explicar artículos de arXiv con foco en sus aportaciones", input: "el enlace o identificador del artículo y las preguntas que quieres resolver", outcome: "un resumen de método, resultados, límites y conceptos clave", prompt: "Lee este artículo de arXiv y explica la contribución principal, el método, la evidencia y las limitaciones.",
  },
  "googleworkspace/cli/persona-researcher": {
    name: "Persona Researcher", purpose: "investigar un tema desde las necesidades de una persona concreta", input: "la persona, la pregunta, el alcance y las fuentes disponibles", outcome: "hallazgos relevantes para esa audiencia con vacíos de información", prompt: "Investiga esta categoría desde la perspectiva de un responsable de TI de una pyme y resume criterios, dudas y objeciones.",
  },
  "nexscope-ai/amazon-skills/amazon-product-research": {
    name: "Amazon Product Research", purpose: "investigar productos y oportunidades en Amazon", input: "la categoría, el mercado, el precio, las palabras clave y los competidores", outcome: "una comparación de demanda, competencia, reseñas y riesgos", prompt: "Investiga esta categoría de Amazon y compara demanda, competencia, problemas de reseñas y oportunidades de diferenciación.",
  },
  "coreyhaines31/marketingskills/customer-research": {
    name: "Customer Research", purpose: "convertir evidencia de clientes en necesidades y mensajes útiles", input: "entrevistas, reseñas, encuestas, tickets y el segmento objetivo", outcome: "problemas, lenguaje del cliente, objeciones y oportunidades", prompt: "Analiza estas entrevistas y crea un mapa de problemas, resultados deseados, objeciones y citas representativas.",
  },
  "firecrawl/firecrawl-workflows/firecrawl-market-research": {
    name: "Firecrawl Market Research", purpose: "recopilar información web para estudiar un mercado", input: "el mercado, las empresas, las preguntas y los sitios que deben investigarse", outcome: "un panorama competitivo con fuentes y comparaciones", prompt: "Investiga este mercado, compara cinco competidores y cita las páginas que respaldan cada conclusión.",
  },
  "firecrawl/firecrawl-workflows/firecrawl-deep-research": {
    name: "Firecrawl Deep Research", purpose: "realizar una investigación web profunda y trazable", input: "la pregunta, el alcance, las fuentes iniciales y los criterios de calidad", outcome: "una síntesis detallada con evidencia, contradicciones y lagunas", prompt: "Investiga esta pregunta en profundidad, contrasta las fuentes y separa conclusiones, incertidumbres y temas pendientes.",
  },
  "anthropics/skills/pdf": {
    name: "PDF", purpose: "leer, extraer y trabajar con información contenida en archivos PDF", input: "los PDF y la tarea de extracción, comparación o resumen", outcome: "contenido estructurado y hallazgos vinculados al documento", prompt: "Compara estos dos PDF, extrae las diferencias de condiciones y señala en qué sección aparece cada una.",
  },
  "coreyhaines31/marketingskills/image": {
    name: "Image", purpose: "planificar y producir recursos visuales para marketing", input: "el objetivo, el formato, la audiencia, la marca y las referencias visuales", outcome: "una dirección visual y prompts listos para crear imágenes", prompt: "Diseña tres conceptos visuales para este lanzamiento y entrega un prompt de imagen claro para cada concepto.",
  },
  "github/awesome-copilot/prd": {
    name: "PRD", purpose: "convertir una idea de producto en un documento de requisitos", input: "el problema, los usuarios, los objetivos, las restricciones y el contexto técnico", outcome: "un PRD con alcance, casos, criterios y preguntas abiertas", prompt: "Convierte esta idea en un PRD conciso con objetivos, fuera de alcance, flujos, criterios de aceptación y riesgos.",
  },
  "google-labs-code/stitch-skills/enhance-prompt": {
    name: "Enhance Prompt", purpose: "mejorar prompts para que sean más claros y controlables", input: "el prompt original, la herramienta de destino y el resultado esperado", outcome: "un prompt mejor estructurado con restricciones explícitas", prompt: "Mejora este prompt para generar una interfaz; conserva la intención y añade estructura, estados y restricciones visuales.",
  },
  "github/awesome-copilot/documentation-writer": {
    name: "Documentation Writer", purpose: "crear documentación técnica útil a partir de código y contexto", input: "el código, la interfaz, la audiencia y el tipo de documento", outcome: "documentación clara con ejemplos y límites relevantes", prompt: "Documenta esta API para usuarios nuevos e incluye requisitos, ejemplo mínimo, errores habituales y solución de problemas.",
  },
  "wshobson/agents/data-storytelling": {
    name: "Data Storytelling", purpose: "convertir análisis de datos en una narrativa comprensible", input: "los datos, el análisis, la audiencia y la decisión que debe apoyarse", outcome: "una historia con contexto, evidencia, visuales sugeridos y conclusión", prompt: "Convierte estos resultados en una historia para dirección: contexto, tres hallazgos, visual recomendado y decisión sugerida.",
  },
};

export const CURATED_SKILL_OVERVIEWS_ES: Readonly<Record<string, CuratedSkillOverview>> =
  Object.fromEntries(Object.entries(DEFINITIONS).map(([rawId, definition]) => [rawId, makeOverview(definition)]));
