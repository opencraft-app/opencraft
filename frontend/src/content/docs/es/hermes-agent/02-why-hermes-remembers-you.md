## Resumen

**Hermes Agent** no te recuerda porque tiene una ventana de contexto más grande, sino gracias a un sistema de memoria a largo plazo con cuatro capas cooperativas: `USER.md` (1.375 caracteres / aproximadamente 500 tokens) cubre "quién eres", `MEMORY.md` (2.200 caracteres / aproximadamente 800 tokens) cubre "qué hemos hecho juntos", una base de datos SQLite + FTS5 para archivos de sesión significa que cualquier frase puede recuperarse con precisión semanas después, y las Skills cubren "cómo debo manejar este tipo de tarea". Las escrituras se organizan deliberadamente por el Agent en cuatro momentos — Compresión, Punto de control, Impulso y instrucción explícita del usuario — mientras que la recuperación combina tres pilares: carga por defecto estructurada, coincidencia exacta de FTS5 y resumen semántico de LLM. Es eso lo que convierte "recordarte" de un concepto en ingeniería.

---

## El momento en que los asistentes de IA más te decepcionan

No es cuando te dan una respuesta incorrecta. Es cuando tienes que decir:

> **"¿No te lo acabo de decir la última vez?"**

Las ventanas de contexto han subido de 8k a 200k y 1M, pero recordar a alguien nunca fue un asunto de meter más tokens: 200k de contexto dentro de una sesión se evaporan en el momento en que esa sesión termina. Para hacer que un Agent recuerde a alguien a largo plazo, hay que responder tres preguntas:

- ¿Qué merece ser escrito en la memoria a largo plazo? (¿Dónde está la puerta de escritura?)
- ¿En qué formato debe almacenarse la memoria para que siga siendo encontrable semanas después?
- Cuando se trata de encontrar algo, ¿el Agent se basa en la similitud de vectores o en algo más?

Hermes responde a las tres con un sistema completo de memoria a largo plazo. Las secciones a continuación lo desglosan en cinco capas.

---

## 1. Primero, define qué significa "recordar"

En términos humanos, "recordarte" contiene al menos tres cosas:

1. **Conocer quién eres** — nombre, rol, preferencias, cadena de herramientas habitual.
2. **Conocer qué hemos hecho juntos** — proyectos discutidos, conclusiones dadas, errores cometidos.
3. **Conocer cómo tratar contigo** — ¿quieres respuestas breves o detalladas? ¿Primero la conclusión o primero el razonamiento?

Un modelo que solo tenga una ventana de contexto grande puede hacer las tres **dentro de una sola conversación**, pero en el momento en que la sesión termina, los puntos 1 y 3 se reinician.

**Enfoque de Hermes**: empujar esas tres cosas en capas de persistencia separadas, cada una mantenida de la manera en que debería — el punto 1 va a `USER.md`, el punto 2 va a `MEMORY.md`, y el punto 3 se mantiene conjuntamente por los campos de preferencia en `USER.md` y el modelado de usuario de Honcho.

---

## 2. Escritura: el Agent organiza deliberadamente en lugar de anotar todo

La memoria a largo plazo de Hermes no es "una entrada por frase". El Agent organiza y persiste la memoria en **cuatro momentos explícitos**:

| Disparador | Propósito |
|---|---|
| **Compresión** | Cuando el contexto se acerca a su límite, primero extraer lo que merece conservarse a largo plazo de la sesión actual, luego comprimir el contexto |
| **Punto de control** | En hitos como terminar una subtarea o cambiar de tema, registrar deliberadamente |
| **Impulso** | El sistema empuja periódicamente al Agent: "¿hay algo aquí que merezca escribir en la memoria a largo plazo?". Esto previene que la información desaparezca silenciosamente en sesiones largas |
| **Instrucción explícita del usuario** | Cuando el usuario dice "recuerda que uso Y en el proyecto X", se reconoce como una escritura de memoria de alta prioridad |

El punto clave: **el Agent mismo decide si algo entra en la memoria a largo plazo**, en lugar de persistir todo. Ese filtro es la primera puerta de control de la calidad de la memoria — y la diferencia más fundamental con el historial de chat que guarda cada frase.

Un cálculo de costos concreto: sin ese filtro, un usuario con 50 interacciones al día vertería aproximadamente **18 millones de tokens** de conversación cruda en la memoria a largo plazo en un año. El enfoque de Hermes comprime eso a **menos del 1%** mientras mantiene casi todos los hechos clave.

---

## 3. Almacenamiento: cuatro capas, cada una con su propio trabajo

Hermes divide la memoria a largo plazo en cuatro tipos, cada uno almacenado en un lugar diferente con un **límite de capacidad explícito**:

| Capa | Soporte | Capacidad típica | Momento de carga | Responsabilidad |
|---|---|---|---|---|
| Perfil de usuario | `USER.md` | ~1.375 caracteres / ~500 tokens | Cada sesión | Quién eres, rol, preferencias, pila de herramientas habitual, estilo de comunicación |
| Memoria factual | `MEMORY.md` + `memories/` | ~2.200 caracteres / ~800 tokens | Cada sesión | Eventos, decisiones, conclusiones, hechos para reutilizar entre sesiones |
| Archivo de sesión | SQLite + índice de texto completo FTS5 | Sin límite (meses de historial) | Cargado cuando una consulta coincide | Cualquier frase original puede recuperarse con precisión semanas después |
| Memoria procedimental | directorio `skills/` (`SKILL.md`) | Escala de KB por archivo | Carga de alta prioridad al coincidir escenario | "¿Qué debo hacer en esta situación" (cubierto por un artículo dedicado en esta categoría) |

Además de esos, Hermes también mantiene un `SOUL.md` — la descripción de la personalidad del Agent. Pertenece al modelo propio del Agent en lugar de la memoria del usuario, pero junto con la memoria del usuario forma la base del contexto.

### ¿Por qué cada capa tiene un límite estricto?

Algunas personas preguntan: si las ventanas de contexto son tan grandes, ¿por qué `USER.md` solo obtiene 500 tokens?

Tres razones:

1. **Cada token extra de 1.000 en el prompt del sistema gasta 18 millones de tokens al año a 50 llamadas al día** — presión de costos seria.
2. **Cualquier cosa cargada en cada sesión debe seleccionarse cuidadosamente** — forma parte del prompt del sistema, y la hinchazón aprieta el contexto real de la tarea.
3. **Un límite obliga a compensaciones** — cuando la capacidad está llena, nada se elimina silenciosamente; el Agent se ve **obligado a consolidar** (ver sección 5).

Eso es la filosofía central de Hermes: **"recordar" no es "almacenar", es "almacenar después de una selección deliberada".**

### Un componente que no debes pasar por alto: Honcho

Hermes también incorpora un componente llamado **Honcho** que realiza **modelado dialéctico del usuario** — en términos sencillos, extrae continuamente afirmaciones reutilizables sobre el usuario de la conversación y las devuelve a la mantención de `USER.md`.

Las preferencias implícitas que los archivos estructurados manejan mal (por ejemplo, "este usuario se impacienta después de las 3pm", o "este usuario es inusualmente sensible a las palabras rellenas") se completan con esta capa de inferencia puramente impulsada por LLM.

---

## 4. Recuperación: estructurada, texto completo y semántica — tres patas

La recuperación en configuraciones tradicionales de RAG se basa fuertemente en la similitud de vectores. Pero los vectores solos tienen dos problemas de larga data: **ser importante no significa ser similar a la consulta**, y **los detalles se diluyen dentro de un pasaje entero**.

La estrategia de recuperación de Hermes se parece más a una recuperación híbrida:

| Método de recuperación | Escenario de disparo | Latencia típica |
|---|---|---|
| **Carga por defecto estructurada** | Inicio de cada conversación | Casi cero (forma parte del prompt del sistema) |
| **Búsqueda de texto completo FTS5** | El usuario pregunta sobre un hecho específico: "¿qué fue ese error de nuevo?" | ~20ms para coincidir, ~1ms para página |
| **Resumen semántico de LLM** | Preguntas que requieren integrar múltiples entradas | Segundos, ejecutado en un modelo barato (como Gemini Flash) |

Esos tres trabajando juntos es lo que hace que "recordarte" sea más que "nuestros vectores son similares" — se convierte en **"realmente sé lo que dijiste".**

Una analogía de post-it ayuda: `USER.md` es **la nota pegada en el borde de tu monitor** (visible cada vez que miras hacia arriba), `MEMORY.md` es **el diario en tu escritorio** (también visible, con más contenido), SQLite+FTS5 es **la caja de archivo en el armario** (rara vez abierta, pero siempre encontrable), y las Skills son **memoria muscular** (tu cuerpo sabe qué hacer cuando llega el momento).

---

## 5. Actualización: la memoria es viva, no un libro de cuentas

Un punto a menudo pasado por alto: **la memoria debe ser modificable y descartable, no solo escribible**. Hermes tiene tres estrategias explícitas aquí:

### Estrategia 1: en conflicto, actualizar en lugar de añadir en paralelo

Esto evita una personalidad dividida — no puedes tener "el usuario prefiere Vue / el usuario cambió a React / el usuario volvió a Vue" sentados lado a lado. Hermes sobrescribe el valor antiguo para los campos de preferencia, mientras que las entradas factuales mantienen el historial pero actualizan un campo de "estado actual".

### Estrategia 2: las entradas no referenciadas durante mucho tiempo se desvalorizan como de bajo valor

`MEMORY.md` tiene un límite estricto (2.200 caracteres). Cuando está lleno, la respuesta es:

```json
{
  "success": false,
  "error": "Memory at 2,100/2,200 chars. Consolidate now...",
  "current_entries": [...],
  "usage": "2,100/2,200"
}
```

Eso no es un error, es una **señal de puerta**: el Agent tiene que hacer compensaciones y fusionar o eliminar entradas obsoletas de bajo valor antes de poder escribir de nuevo.

### Estrategia 3: la información que el usuario niega explícitamente se elimina inmediatamente

No "registrar lo contrario", sino **eliminación física** — manteniendo el modelo del mundo autoconsistente.

En otras palabras, Hermes se acerca más a **editar un archivo vivo** que a añadir a un diario.

---

## 6. Una cosa que falta aún para que esto funcione en la práctica

Sin embargo, tan bueno que sea el mecanismo de memoria, tiene un requisito previo: **el Agent tiene que mantenerse vivo**.

Si instalas Hermes en tu propia laptop, se duerme cada vez que cierras la tapa, y el bucle de reflexión de fondo (impulso) se detiene. Cambiar de máquina o reinstalar el sistema operativo significa mover `~/.hermes/` a mano, y el índice FTS5 tiene que ser reconstruido desde cero cada vez.

Aquí es donde el alojamiento en la nube se vuelve verdaderamente útil. [**LightVela**](https://lightvela.ai/) es un **servicio de Hermes Agent alojado en la nube**:

- Una instancia en la nube dedicada en línea 24×7, con `MEMORY.md` / `USER.md` / el archivo de sesión SQLite viviendo allí permanentemente;
- El bucle de impulso de fondo sigue corriendo, así que el Agent realmente crece incluso cuando no lo estás usando;
- Los datos permanecen solo en tu servidor dedicado;
- Teléfono, laptop, Telegram, Slack, Lark — cada canal llega al mismo Agent que te conoce.

Hermes convirtió "recordarte" en un diseño de ingeniería funcional; LightVela hace que ese diseño tenga efecto **cada día, justo al lado tuyo.**

---

## Puntos clave

- Hermes te recuerda mediante **curaduría deliberada, almacenamiento en capas, recuperación híbrida y actualización continua** — no una ventana más grande.
- Cada capa tiene una capacidad explícita: 500 tokens para `USER.md`, 800 tokens para `MEMORY.md`, sin límite para SQLite y carga basada en escenarios para Skills.
- Un buen sistema de memoria de Agent **edita un archivo** en lugar de **añadir a un diario** — los límites obligan a compensaciones.
- El objetivo de LightVela es llevar esta capacidad desde la línea de comandos a un producto, para que ser recordado sea la experiencia por defecto.
