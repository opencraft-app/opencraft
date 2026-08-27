## Resumen

**La curación de la memoria a largo plazo de Hermes Agent no se trata de almacenar más; sigue cuatro reglas de hierro que mantienen la memoria "pocos pero precisos":**

1. **Limitada**: `USER.md` a ~1,375 caracteres y `MEMORY.md` a ~2,200 caracteres fuerzan la concisión.
2. **Congelada**: no se realizan reescrituras dentro de una sesión, protegiendo el caché KV y la estabilidad de la inferencia.
3. **Transparente**: cada escritura se anuncia (`💾 Memory updated`) y puede ser aprobada, revertida y revisada con `/journey`.
4. **Auto-consolidante**: cuando la capacidad está llena, nada se elimina silenciosamente; una respuesta de `Memory at 2,100/2,200 chars. Consolidate now...` obliga al Agent a tomar decisiones mediante las tres operaciones atómicas `add / replace / remove`.

**El resultado**: el Agent te entiende mejor con el tiempo sin nunca volverse engomado, y la memoria se enriquece sin nunca salirse de control.

---

## Un malentendido común

> "Cuanto más recuerda un asistente de IA, más inteligente es."

Lo contrario es cierto. **Recordar mucha información de calidad mixta hace que un Agent sea más tonto** — comienza a tratar tus declaraciones temporales, erróneas y desactualizadas como hechos estables sobre ti. Un sistema de memoria a largo plazo genuinamente útil siempre es **pocos pero precisos**.

Para lograr eso, Hermes responde a cuatro preguntas:

- ¿Qué merece entrar en la memoria a largo plazo? (**el filtro de escritura**)
- ¿Cómo se convierten los fragmentos entrantes en entradas bien formadas? (**curación**)
- ¿Qué sucede cuando la información cambia? (**semántica de actualización**)
- ¿Qué sucede cuando la capacidad está llena? (**consolidación forzada**)

Las secciones a continuación abordan las cuatro en orden.

---

## 1. Escritura: el Agent es el primer filtro

El primer filtro de Hermes es el **filtro de escritura**. En lugar de almacenar cada frase, el Agent **juega por sí mismo** si escribir o no en cuatro momentos explícitos:

- **Compresión**: cuando el contexto se acerca a su límite, el Agent revisa la sesión actual y extrae lo que vale la pena guardar entre sesiones.
- **Punto de control**: en momentos como cerrar una tarea o cambiar de tema, toma el inventario de la memoria.
- **Impulso**: el sistema pregunta periódicamente al Agent, "¿hay algo en este tramo que merezca memoria a largo plazo?" para que los fragmentos importantes no se pierdan.
- **Instrucción explícita del usuario**: "por favor recuerda X" se escribe con prioridad.

Los criterios de juicio suelen incluir:

| Dimensión | Significado | Contraejemplo |
|---|---|---|
| Reutilización | ¿Podría ser útil en otras tareas más adelante? | "Quiero un latte hoy" |
| Estabilidad | ¿Es temporal o de larga duración? | "me duele la cabeza hoy" |
| Especificidad | ¿Una actitud vaga o un hecho reutilizable? | "Creo que prefiero un poco más conciso" |
| Sensibilidad a la privacidad | Correos, contraseñas, direcciones no confirmadas explícitamente | No se escriben por defecto |

**Un Hermes Agent bien entrenado preferiría recordar demasiado poco que recordar descuidadamente.**

---

## 2. Curación: reescribir fragmentos en entradas

Incluso después de pasar el filtro de escritura, la información entrante suele ser fragmentaria. El segundo paso de Hermes es **reescribir fragmentos en entradas bien formadas**.

Por ejemplo, la conversación cruda podría ser:

> "Oh, eso, esa API de la nuestra se cambió para ir por la pasarela en lugar de golpear el servicio directamente — eso fue la semana pasada."

Hermes no guarda eso tal cual. Escribe:

```md
- [~2026-07-24] Project X's API now routes through the gateway instead of connecting directly.
```

Cuatro cosas sucedieron allí:

- **Extracción de hechos**: palabras rellenas como "oh, eso" se eliminan.
- **Resolución de sujetos**: "esa API de la nuestra" se convierte en "Proyecto X".
- **Anclaje temporal**: "la semana pasada" se convierte en una fecha aproximada.
- **Recuperabilidad**: escrito como una entrada estructurada para que FTS5 pueda coincirla más adelante (~20 ms para coincidir, ~1 ms para paginar).

Solo después de la curación estructurada tiene una entrada una oportunidad de ser **recordada meses después**.

---

## 3. Tres operaciones atómicas: agregar / reemplazar / eliminar

Cada modificación que Hermes hace a `MEMORY.md` debe caer en una de tres operaciones atómicas:

| Operación | Semántica | Disparador |
|---|---|---|
| **agregar** | Agregar una nueva entrada | Nuevo evento, nueva decisión |
| **reemplazar** | **Sobrescribir** una entrada antigua con una nueva | Cambio de estado ("la API ahora va por la pasarela" sobrescribe "la API se conecta directamente") |
| **eliminar** | Eliminación física | Denegación del usuario, entradas expiradas, entradas antiguas fusionadas por consolidación |

**¿Por qué no se permiten operaciones difusas (como "solo actualizar los campos relacionados")?**

Razón 1: las operaciones atómicas son auditables. Cada cambio de memoria se mapea a "esta entrada → esa entrada", lo que hace posible una revisión precisa como `/memory diff <id>`.

Razón 2: obliga al Agent a decidir explícitamente. "¿Estoy reemplazando o agregando?" — esa elección binaria es donde comienzan las compensaciones, y previene personalidades divididas.

Razón 3: sienta las bases para el filtro de aprobación (sección 7), donde cada ítem pendiente puede ser aprobado o rechazado independientemente.

---

## 4. Semántica de actualización: modificar primero, nunca appendar lo opuesto

Aquí es donde caen los sistemas de memoria simples: **¿qué sucede cuando la información cambia?**

El enfoque ingenuo es agregar otra entrada, lo que deja al Agent sosteniendo todas estas a la vez:

- "el usuario prefiere Vue"
- "el usuario cambió más tarde a React"
- "el usuario volvió a Vue"

Tres entradas paralelas, y el modelo en sí ya no sabe cuál confiar.

Hermes **actualiza en lugar de appendar lo opuesto**:

- Los campos de preferencia en `USER.md` tienden a **sobrescribir el valor antiguo** (`reemplazar`).
- En `MEMORY.md`, los eventos históricos se mantienen pero el **campo de estado actual se actualiza** (`reemplazar`), dejando una breve huella de migración.
- Cualquier cosa que el usuario niegue explícitamente ("nunca fui así") se **elimina** — **eliminado físicamente**, no registrado como "el usuario negó X".

El punto de todo esto es mantener el modelo del mundo del Agent **auto-consistente**.

---

## 5. Cuando la capacidad está llena: Consolidar ahora

Hermes establece un límite duro de **~2,200 caracteres** para `MEMORY.md`. A medida que se llena, cualquier `add` devuelve:

```json
{
  "success": false,
  "error": "Memory at 2,100/2,200 chars. Consolidate now...",
  "current_entries": [...],
  "usage": "2,100/2,200"
}
```

**Eso no es un error, es el diseño.**

Si las entradas más antiguas se eliminaran automáticamente cuando la capacidad se llenara, el Agent nunca aprendería a hacer compensaciones — información importante podría ser expulsada mientras la información irrelevante se queda. Hermes hace lo contrario: **se rechazan las escrituras hasta que el Agent limpie el espacio por sí mismo.**

La consolidación suele involucrar:

- **Agrupación por tema**: varias entradas similares se resumen por un LLM en una memoria más amplia.
- **Archivado por expiración**: "el objetivo del sprint de esta semana es…" se **elimina** después de que pasa la fecha.
- **Descenso de peso por frecuencia de acceso**: las entradas no recordadas durante mucho tiempo se mueven al final de la cola y se fusionan o eliminan primero.

Juntos, estos mecanismos significan que **tus comentarios de pasada de hace meses no continúan contaminando el juicio del Agent sobre ti**, mientras que la información verdaderamente importante se refuerza repetidamente.

---

## 6. Un bucle de aprendizaje consciente del consentimiento: el Agent aprende en el fondo sin interrumpirte

Hermes tiene una capacidad más oculta: un **bucle de auto-reflexión en el fondo**. Periódicamente:

1. extrae las sesiones más recientes;
2. ejecuta un modelo barato (como Gemini Flash) sobre ellos para extraer lo que vale la pena recordar;
3. produce entradas candidatas de memoria marcadas `[auto]`.

Hacia arriba esto se llama un **bucle de aprendizaje consciente del consentimiento** — **el aprendizaje no debe interrumpir al usuario**, pero el usuario puede intervenir en cualquier momento.

Los beneficios:

- **El costo baja a un tercio o un quinto**: un modelo barato maneja la revisión, con casi ningún impacto en la calidad de captura en pruebas hacia arriba.
- **El Agent crece incluso cuando no lo estás usando** — siempre que esté en línea.
- **Sin interferencia con la conversación de primer plano**: las entradas candidatas esperan en el filtro de aprobación en la siguiente sección.

---

## 7. El filtro de aprobación: si no te sientes cómodo con que el Agent actúe por su cuenta

Algunos usuarios se preocupan: "¿qué pasa si el Agent escribe algo incorrecto en MEMORY automáticamente?"

Hermes ofrece un interruptor explícito:

```yaml
memory:
  write_approval: true    # turn on the approval gate
```

Con eso activado, **todas** las escrituras de memoria (incluidas las automáticas del reflejo en el fondo) se estancan para revisión. Los usuarios las revisan con:

```
/memory pending           # list pending entries (background reflection marks them [auto])
/memory diff <id>         # inspect a specific change
/memory approve <id>      # approve (or all)
/memory reject <id>       # reject
```

Las Skills tienen un `skills.write_approval` separado, porque un `SKILL.md` puede ser largo y incómodo de mostrar en línea; Hermes proporciona `/skills diff <id>` para que puedas leer la diferencia unificada completa.

El filtro de aprobación es esencialmente un desacoplamiento explícito de **el aprendizaje autónomo del Agent** de **la soberanía del usuario** — el Agent puede acumular experiencia libremente, pero **cada reescritura de los registros propios del usuario** debe pasar por el usuario.

---

## 8. Transparencia: puedes ver cada actualización de memoria

Hermes expone las acciones de memoria a través de notificaciones en tiempo real:

| Configuración | Se muestra como |
|---|---|
| `off` | Escrituras silenciosas, nada mostrado |
| `on` (predeterminado) | `💾 Memory updated` |
| `verbose` | `💾 Memory ➕ User prefers terse replies` (con una vista previa del contenido) |

De "algo fue recordado" a "esta entrada exacta fue recordada", la granularidad es tuya. Ese nivel de **observabilidad** es raro entre los Agents de IA — la mayoría trata la memoria como una caja negra.

---

## 9. Viaje de Aprendizaje: revisar cómo el Agent creció

Si quieres **mirar hacia atrás** en lo que el Agent ha aprendido a lo largo de meses, Hermes proporciona `/journey` (alias `/learning`, `/memory-graph`):

- CLI: `hermes journey` (soporta `--play` reproducción animada y `--json` exportación)
- TUI: la capa `/journey`
- Escritorio: el panel interactivo Star Map

Con comandos de limpieza correspondientes:

```bash
hermes journey list           # list all nodes
hermes journey delete <node>  # archive a Skill (recoverable) or delete a memory
hermes journey edit <node>    # open in $EDITOR
```

Esta herramienta importa mucho más allá de la novedad — reconoce algo real: **la forma en que un Agent crece es en sí misma digna de revisión.**

---

## 10. ¿Por qué esta restricción importa en la práctica

Pon todo lo anterior junto y la filosofía de memoria de Hermes se reduce a **cuatro reglas de hierro**:

1. **Limitada**: los techos de caracteres fuerzan la concisión.
2. **Congelada**: no hay cambios dentro de una sesión, protegiendo el caché.
3. **Transparente**: cada escritura es visible para el usuario, aprobable y revertible.
4. **Auto-consolidante**: un almacén lleno nunca se elimina silenciosamente; el Agent se ve obligado a hacer compensaciones.

Cuando se comercializa "memoria de IA", muchos productos enfatizan qué tan grande es el almacén de memoria que soportan y cuántas entradas pueden contener. Desde la perspectiva del usuario, sin embargo, solo tres cosas importan:

1. **¿Recordó las cosas que realmente importan?**
2. **¿Actualizó prontamente la información que ya no se mantiene?**
3. **¿Se volverá más verboso y más propenso a errores porque recordó una pila de cosas irrelevantes?**

**Un sistema de memoria que puede responder "qué no debe recordarse" es un buen sistema de memoria.**

---

## 11. Una cosa falta aún para que esto funcione en la práctica

Sin embargo, tan bueno que sea el mecanismo de memoria, tiene un requisito previo: **el Agent tiene que estar vivo**.

Si instalas Hermes en tu propia laptop, se duerme cada vez que cierras la tapa, el bucle de reflexión en el fondo se detiene y `nudge_interval` nunca alcanza su siguiente disparador. Cambiar de máquina o reinstalar el sistema operativo significa mover `~/.hermes/` a mano.

Aquí es donde el alojamiento en la nube se vuelve verdaderamente útil. [**LightVela**](https://lightvela.ai/) es un **servicio de Hermes Agent alojado en la nube**:

- Una instancia en la nube dedicada en línea 24×7, con `MEMORY.md` / `USER.md` / el archivo de sesión de SQLite viviendo allí permanentemente;
- El bucle de reflexión en el fondo sigue corriendo, así que el Agent verdaderamente crece incluso cuando no lo estás usando;
- Los datos se quedan solo en tu servidor dedicado;
- Teléfono, laptop, Telegram, Slack, Lark — cada canal llega al mismo Agent que te conoce.

Hermes llevó la filosofía de "más memoria no es mejor" a su conclusión lógica; **LightVela hace que esa filosofía tenga efecto cada día, justo al lado tuyo**. Así es como se cumple la promesa de entenderme mejor con el tiempo.

---

## Puntos clave

- Un buen sistema de memoria = **escritura estricta + curación estructurada + tres operaciones atómicas + consolidación forzada + reflexión en el fondo + filtro de aprobación + transparencia completa**.
- Recordar más no significa ser más inteligente; reconocer "qué no debe recordarse" y verse obligado a hacer compensaciones importa más.
- Hermes proporciona la referencia de ingeniería; LightVela busca convertirlo en una experiencia de producto que los usuarios puedan realmente alcanzar.
