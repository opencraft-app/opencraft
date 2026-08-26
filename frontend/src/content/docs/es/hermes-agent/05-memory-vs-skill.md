## Resumen

**La Memoria y la Skill son ambas memoria a largo plazo, pero son fundamentalmente diferentes. La Memoria es memoria declarativa: almacena hechos, eventos, conclusiones y preferencias como entradas breves, y se recupera cuando una consulta coincide (`MEMORY.md` + `memories/`). La Skill es memoria procedimental: almacena el SOP (Operación Estándar Operativa) de "qué hacer cuando ocurre la situación X" como un YAML con disparador más un procedimiento, y se carga con alta prioridad cuando el escenario coincide (el directorio `skills/` + `SKILL.md`). Tres restricciones estrictas los mantienen separados: diferentes disparadores (coincidencia de consulta vs coincidencia de escenario), diferentes formas (entradas vs procedimientos paso a paso) y diferentes tasas de cambio (la Memoria cambia diariamente, las Skills pueden permanecer inalteradas durante meses). Un Agent que camina sobre ambas piernas tanto te entiende como sabe cómo trabajar.**

---

## ¿Por qué estos dos conceptos siguen generando confusión

Si Hermes Agent tiene un diseño que es especialmente fácil de malinterpretar, es la separación limpia entre **Memoria** y **Skill**.

La primera reacción de la mayoría de la gente son tres preguntas:

- "¿No son ambas memoria a largo plazo? ¿Por qué separarlas?"
- "Ambas son Markdown, entonces ¿por qué no ponerlas juntas?"
- "Recordar 'el frontend del Agent-demo se ejecuta en un puerto local de desarrollo' y recordar 'resumir primero, luego listar cambios al escribir una descripción de PR' — ¿no es lo mismo?"

La respuesta corta: **porque el cerebro humano las separa también.**

---

## 1. La ciencia cognitiva ya ha establecido esta distinción: declarativa vs procedimental

La psicología ha distinguido durante mucho tiempo dos tipos de memoria a largo plazo:

| Tipo | Definición | Ejemplo | Cómo se invoca |
|---|---|---|---|
| **Declarativa** | Hechos que puedes declarar | "Vivo en Beijing", "React 18 introdujo el renderizado concurrente" | Al ser **declarado** |
| **Procedimental** | Skills que puedes realizar pero que quizás no puedas explicar | Pedalar una bicicleta, escribir con los dedos, redactar una descripción de PR bien estructurada | Al ser **ejecutado** |

Estos dos tipos de memoria difieren en **cómo se almacenan, invocan y actualizan**: la memoria declarativa puede verbalizarse (el canal verbal), mientras que la memoria procedimental se realiza mayormente (el canal motor). En experimentos psicológicos, pacientes con daño hipocampal tienen una memoria declarativa severamente deteriorada, pero aún pueden aprender tareas procedimentales como la escritura en espejo — **dos vías independientes, no dos expresiones de una misma vía.**

Hermes Agent traslada esa distinción directamente en su diseño del sistema:

- **Memoria (`memories/`, `MEMORY.md`)**: la memoria declarativa del Agent.
- **Skill (`skills/`)**: la memoria procedimental del Agent.

---

## 2. Memoria: lo que el Agent puede declarar

El sistema de memoria almacena **hechos, eventos, conclusiones y preferencias**:

- "Jasmin está trabajando en el sitio global para agent-demo."
- "La semana pasada se cambió la sección heroica a un degradado animado."
- "El proyecto se ejecuta en Next.js, con el servidor de desarrollo frontend en un puerto local de desarrollo."

Sus características:

- **Declarativa**: existe como oraciones cortas y entradas que pueden citarse directamente en un prompt.
- **Recuperado bajo demanda**: cuando surge un tema relacionado, la coincidencia FTS5 trae las entradas relevantes.
- **Volátil**: se agregan nuevas entradas, las antiguas se `reemplazan` o se `eliminan`.

**Piense en la Memoria como el cuaderno del Agent** — uno abierto sobre la mesa, lleno de hechos específicos.

---

## 3. Skill: lo que el Agent puede hacer

Una Skill almacena el **procedimiento estándar para una clase de tareas**. Una Skill Hermes típica es un `SKILL.md` cuyo frontmatter YAML declara las condiciones de disparo y los conjuntos de herramientas que respalda:

```yaml
---
name: pr-description-format
trigger:
  when: "user asks to write a PR description"
fallback_for_toolsets: [git, code-review]
---

# Standard procedure for writing a PR description

1. Summarize the goal of the change in one sentence
2. List the changes (grouped by module)
3. Blast radius
4. Testing status
5. Related issue / rollback plan
```

Sus características:

- **Procedimental**: existe como "cuándo disparar + cómo hacerlo", cercano a un SOP reutilizable.
- **Disparado por escenario**: cuando el Agent reconoce una situación coincidente, la Skill se **carga automáticamente como un prompt de alta prioridad** que guía esa acción.
- **Relativamente estable**: una vez que una Skill se asienta, usualmente permanece en su lugar; lo que cambia son los escenarios y el material en la Memoria que se vinculan a ella.

**Piense en la Skill como la memoria muscular del Agent** — no se necesita recuperación, el movimiento simplemente ocurre.

Los usuarios de Hermes también pueden ejecutar `/learn` para que el Agent destile "la parte de esta sesión digna de codificar" en un nuevo `SKILL.md` — mucho como un mentor transmite un método a un aprendiz.

---

## 4. "¿Por qué no fusionarlos?" — tres restricciones estrictas

Alguien preguntará: son ambos Markdown, ambas memoria a largo plazo, entonces ¿por qué no ponerlos juntos?

Porque no funciona. Las razones se asemejan a las tres restricciones que mantienen a `USER.md` y `MEMORY.md` separados, pero son incluso más fuertes aquí.

### Restricción 1: diferentes disparadores

- La Memoria es "**recuperada cuando una consulta coincide**" (FTS5 más resúmenes semánticos).
- La Skill es "**cargada cuando un escenario coincide**", usualmente con un disparador explícito (`trigger.when: "user asks to write a PR description"`).

Fusionados, el Agent perdería la pista de si está citando un hecho o siguiendo un procedimiento.

### Restricción 2: diferentes formas

- La Memoria son **oraciones cortas, hechos, entradas** ("[2026-07-30] Agent-demo frontend puerto local de desarrollo").
- La Skill es **procedimiento, plantilla, restricción**, usualmente con frontmatter YAML más ordenamiento "paso 1 / 2 / 3".

Empaquetados juntos, el Agent no puede distinguir "¿esto es contexto o algo que debo ejecutar ahora mismo?"

### Restricción 3: diferentes tasas de cambio

- **La Memoria cambia cada día** (una sola sesión puede agregar una o dos entradas).
- **Una Skill puede permanecer inalterada durante meses** (un SOP para descripciones de PR no necesita ediciones durante medio año).

Ponerlos juntos permite que las entradas factuales de alta frecuencia laven el SOP estable — como vincular una constitución y un calendario de escritorio en el mismo cuaderno.

---

## 5. Un escenario real: `/learn` y Memoria trabajando juntas

Supongamos que le dice al Agent:

> "A partir de ahora nuestro equipo escribe descripciones de PR en este formato: resumen de una oración, lista de cambios, radio de explosión, estado de pruebas. También, recuerda que este proyecto se llama agent-demo y el frontend se ejecuta en un puerto local de desarrollo."

Un Hermes Agent bien entrenado maneja esto de la siguiente manera:

- **Primera mitad** → la ruta `/learn`, escribiendo una nueva **Skill**: `pr-description-format.md`, disparada por `user asks to write a PR description`.
- **Segunda mitad** → la operación atómica `add`, escribiendo una entrada de **Memoria**: `- [2026-07-30] agent-demo: servidor de desarrollo frontend en un puerto local de desarrollo`.

La próxima vez que diga "escríbeme una descripción de PR", el Agent:

1. **Coincide el escenario y carga la Skill**: `pr-description-format.md` entra al prompt de alta prioridad.
2. **Coincide la Memoria por consulta**: sabe que el proyecto actual es agent-demo, ejecutándose en un puerto local de desarrollo.
3. **Combina ambos**: produciendo una descripción de PR que sigue el estándar del equipo y se ajusta al proyecto específico.

**Recordar hechos más recordar procedimientos es lo que hace que el resultado sea mejor que la suma de sus partes.**

---

## 6. Paquetes de Skills y fallback_for_toolsets

Hermes agrega dos capas de organización sobre las Skills:

- **Paquete de Skill**: Skills relacionadas se empaquetan como un grupo. Un paquete de "pipeline de lanzamiento" podría contener `pre-release-checklist`, `changelog-format` y `deploy-rollback`, habilitado, deshabilitado o compartido como unidad.
- **`fallback_for_toolsets`**: una Skill puede declarar que respalda un conjunto de herramientas cuando este falla. Por ejemplo, cuando el conjunto de herramientas `git` falla, una Skill con pasos de recuperación manual de rebase se activa.

Juntos, esto convierte a las Skills en SOPs de punto único en **metodología de trabajo componible** — una manera completa de trabajar que el usuario trae al Agent, capturada como activos compartibles.

---

## 7. No es una idea nueva, pero raramente implementada correctamente

Capas de memoria factual y procedimental se han discutido en círculos de IA durante mucho tiempo. En realidad ingenierizarla, y hacer que sea **visible, editable y reutilizable por los usuarios**, es donde Hermes está relativamente por delante — mapea cada capa a directorios concretos, campos y comandos:

| Capacidad | Lado de Memoria | Lado de Skill |
|---|---|---|
| Directorio primario | `~/.hermes/memories/` | `~/.hermes/skills/` |
| Entrada de capa de prompt | `MEMORY.md`, `USER.md` | `SKILL.md` cargado al coincidir escenario |
| Comandos de captura | `add / replace / remove` (impulsado por Agent más `/memory pending` aprobación) | `/learn` (impulsado por Agent más `/skills pending` aprobación) |
| Organización | Entradas más índice de texto completo FTS5 | Un SOP único más Paquetes y `fallback_for_toolsets` |
| Tasa de cambio | Diaria | Meses |

Traer esa capa a un contexto de producto y obtienes una forma con potencial real:

- **La Memoria es el archivo compartido entre tú y el Agent.**
- **La Skill es la metodología de trabajo que traes al Agent.**

Juntos, esos dos hacen que el Agent sea un socio que **te entiende y sabe cómo trabajar** — no un chatbot con una memoria decente.

---

## 8. LightVela: convertir tanto Memoria como Skill en activos del usuario

Hermes ya hizo la separación Memoria / Skill utilizable en términos de ingeniería, pero aún es **Markdown para desarrolladores**. El enfoque de LightVela es elevar esa capa de una característica técnica a un **activo del usuario**:

- **Una biblioteca personal de Skills**: los usuarios pueden recopilar, editar y compartir sus propias Skills (flujos de trabajo) como recopilan prompts, y vincularlas a escenarios de disparo. Tus patrones de escritura, SOPs de revisión y estándares de traducción pueden convertirse en Skills.
- **Una biblioteca personal de Memoria**: cada memoria factual que el Agent mantiene sobre ti es transparente, visible, corregible y deletable — no es necesario editar `~/.hermes/MEMORY.md`.
- **Reutilización a nivel de equipo**: tanto Skills como Memoria pueden capturarse en el alcance del equipo, así que un nuevo miembro hereda automáticamente la memoria compartida del equipo y los métodos compartidos en lugar de depender de la boca a boca.
- **La ruta más corta**: si el modelo de "dos piernas" te apela pero prefieres no lidiar con Ollama, SSH, systemd y copias de seguridad de `~/.hermes/`, LightVela es la ruta más corta hacia ese modelo como producto terminado.

En otras palabras, entrenar un Agent en LightVela significa **acumular dos activos a la vez**: la Memoria sobre ti, y tu colección de Skills. **Esos dos activos son lo que te pertenece a largo plazo — importan más que el modelo en sí.**

---

## Puntos clave

- Memoria ≠ Skill. El primero es **memoria declarativa** (hechos que se pueden declarar), el segundo es **memoria procedimental** (métodos que se realizan).
- Tres restricciones estrictas los mantienen separados: **diferentes disparadores / diferentes formas / diferentes tasas de cambio.**
- Un Agent maduro debe caminar sobre ambas piernas — recordando hechos y recordando métodos.
- LightVela convierte ambos en activos del usuario, así que "entrenar tu propio Agent" se convierte en una experiencia de producto que puedes construir en lugar de un eslogan.

---

## ¿A dónde nos deja esto

A través de esta categoría, cinco artículos cubren el terreno:

1. Cómo Hermes Agent difiere de OpenClaw (**acumulación vs conexión**)
2. Cómo Hermes Agent recuerda a los usuarios (**cuatro capas estructuradas de memoria**)
3. Por qué Hermes Agent divide la memoria en dos (**`USER.md` vs `MEMORY.md`**)
4. Por qué más memoria no es mejor: cómo Hermes Agent filtra, curación y actualiza la memoria a largo plazo (**cuatro reglas de hierro**)
5. La memoria no es la Skill: cómo la memoria factual y procedimental difieren (**caminando sobre ambas piernas**)

**Una línea para cerrar**: la fosa para la próxima generación de Agents no es el tamaño del modelo, sino si un Agent verdaderamente **te conoce** (Memoria) y **tiene un método** (Skill) — y si esos dos pueden funcionar confiablemente a largo plazo depende de si **permanece vivo**. Eso es exactamente por qué existe LightVela.
