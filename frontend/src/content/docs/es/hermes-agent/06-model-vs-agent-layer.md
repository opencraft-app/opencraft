## Resumen

**El "cerebro" de un Hermes Agent puede reemplazarse, pero lo que se reemplaza es solo la capa de modelo, no todo el Agent. La capa de modelo decide cómo pensar en este momento: analizar la solicitud, planificar pasos, elegir qué herramienta llamar y redactar la respuesta. La capa de Agent mantiene ese pensamiento activo a lo largo del tiempo: la identidad (`SOUL.md`), el perfil de usuario (`USER.md`), los hechos entre sesiones (`MEMORY.md` y `memories/`), los métodos capturados (`skills/`), los canales de mensajería, las automatizaciones y el directorio de trabajo todos viven fuera del modelo. Por eso, cambiar de modelo no elimina nada. En LightVela, un Agent utiliza exactamente un modelo activo a la vez, y cambiar de modelo no borra la memoria, los archivos de almacenamiento en la nube, las Skills ni la configuración de automatización; solo cambia el motor detrás de las futuras respuestas. Si un Agent se siente como un extraño después de un cambio, la causa es casi siempre un seguimiento de instrucciones diferente, una compresión de contexto distinta y un comportamiento de redacción diferente en el nuevo modelo, no una pérdida de memoria.**

---

## ¿Por qué esta pregunta sigue apareciendo

"¿Puedo mover mi Agent a un modelo más fuerte?" es una de las preguntas más comunes que la gente hace sobre productos de Agent. La pregunta de seguimiento llega inmediatamente: "¿Me recordará todavía?".

Hacer ambas preguntas juntas revela un malentendido extendido: que el modelo y el Agent son lo mismo. En ese modelo mental, un Agent es solo una interfaz de chat envuelta alrededor de un LLM, por lo que reemplazar el modelo significa reemplazar al asistente completo, y empezar de nuevo se siente inevitable.

Si eso fuera realmente cierto, ningún Agent podría tener valor a largo plazo. El contexto del proyecto que explicaste la semana pasada, el tono que ajustaste cuidadosamente, el flujo de trabajo que capturaste —todo eso se reiniciaría con cada actualización técnica. Eso no es un producto en el que nadie pueda confiar.

Hermes Agent se construye sobre la premisa opuesta: **el modelo es un componente reemplazable, y el Agent es lo que persiste**. Este artículo desglosa lo que eso significa en la práctica.

---

## 1. Separe tres cosas primero: modelo, tiempo de ejecución y activos a largo plazo

Antes de discutir el cambio de modelo, ayuda reconocer que un Agent contiene al menos tres capas con ciclos de vida muy diferentes.

| Capa | ¿Qué es | Ciclo de vida | Al cambiar de modelo |
|---|---|---|---|
| **Capa de modelo** | El LLM que proporciona razonamiento y generación | Configurable, reemplazable en cualquier momento | Reemplazada |
| **Tiempo de ejecución de Agent** | El proceso que ejecuta herramientas, I/O de canales y programación | De larga duración | Sin cambios |
| **Activos a largo plazo** | `SOUL.md`, `USER.md`, `MEMORY.md`, `memories/`, `skills/`, archivos del directorio de trabajo | Acumulados con el tiempo | Sin cambios |

La mayoría de la gente solo ve la primera capa y la ventana de chat, perdiendo el tiempo de ejecución en el medio y la capa de activos debajo. Sin embargo, esas dos capas inferiores son exactamente lo que hace que un Agent sea reconociblemente "el mismo" a lo largo de meses de uso.

Una analogía útil: el modelo es cómo piensa una persona en este momento, el tiempo de ejecución es el cuerpo y las manos de esa persona, y los activos a largo plazo son su identidad, sus memorias y sus hábitos profesionales. Cambiar cómo piensa alguien no lo hace una persona diferente, porque la identidad y la memoria no cambiaron con ello.

---

## 2. La capa de modelo: responsable de "cómo pensar esta vez"

Dentro de un solo intercambio, la capa de modelo hace más que producir texto. Decide al menos cuatro cosas:

1. **Interpretación** — transformar tu mensaje en un objetivo concreto, incluyendo restricciones que implícitamente indicaste pero no escribiste explícitamente.
2. **Planificación** — juzgar cuántos pasos necesita el trabajo, qué va primero y si la investigación debe preceder a la acción.
3. **Decisiones de llamada de herramienta** — decidir si leer un archivo, buscar en la web o ejecutar un comando, y con qué argumentos.
4. **Expresión** — organizar el resultado en lenguaje legible, incluyendo cuánto detalle incluir y qué formato usar.

Las cuatro pertenecen a *este* paso de inferencia. Moldean tu experiencia inmediata directamente, por lo que cambiar de modelo produce cambios notables en la sensación.

Igualmente importante es lo que la capa de modelo **no** posee:

- El modelo no es tu base de datos. No almacena tus preferencias, estado del proyecto o conclusiones pasadas.
- El modelo no es un programador. No tiene conocimiento de que algo debe ejecutarse cada mañana a las siete.
- El modelo no es un administrador de canales. No decide a qué conversación de Telegram una respuesta debe retornar.

Todas esas capacidades viven fuera del modelo. Eso es la base técnica para "cambiar de modelo no significa cambiar Agents".

---

## 3. La capa de Agent: responsable de hacer el pensamiento continuo

Las responsabilidades de la capa de Agent se dividen en cinco grupos, organizados por el problema que resuelve cada uno.

### 3.1 Identidad y reglas de comportamiento: `SOUL.md`

`SOUL.md` define quién es este Agent, qué tono funciona, cómo prioriza y qué no hará. Es un conjunto estable de reglas, no un estado de ánimo improvisado por conversación.

Después de un cambio de modelo, `SOUL.md` sigue exactamente donde estaba. El nuevo modelo lee y aplica las mismas reglas — **puede seguirlos más holgadamente o más estrictamente, pero las reglas mismas no cambiaron**. Esa distinción es la clave para entender la sección "se siente diferente" más adelante.

### 3.2 Perfil de usuario: `USER.md`

`USER.md` contiene información estable sobre ti: hábitos lingüísticos, ritmo de comunicación preferido, herramientas que usas regularmente, cosas explícitas a evitar. Libera al Agent de preguntar "¿quieres la versión larga o la corta?" cada sola vez.

### 3.3 Hechos entre sesiones: `MEMORY.md` y `memories/`

Esta capa almacena hechos y conclusiones que ya ocurrieron y se juzgaron dignos de guardar: qué nombre tiene el proyecto, qué se decidió la semana pasada, por qué un parámetro se configura de esa manera. Hermes construye un índice completo de texto SQLite + FTS5 sobre estas entradas y recuerda las que coinciden cuando levantas un tema relacionado, en lugar de meter toda la historia en el contexto.

La memoria no es solo "append" para siempre. Se mantiene mediante operaciones atómicas `add` / `replace` / `remove` y puede revisarse mediante `/memory pending`. Para el diseño completo, ve "¿Por qué más memoria no es mejor: Cómo Hermes Agent Selecciona, Curación y Actualiza la Memoria a Largo Plazo".

### 3.4 Métodos capturados: `skills/`

`skills/` almacena procedimientos estándar para "cuando la situación X ocurre, haz esto". Cada `SKILL.md` típicamente lleva frontmatter YAML que declara sus condiciones de disparo. Esto es memoria procedimental, una vía separada de la memoria declarativa — ve "La Memoria No es una Skill: Cómo Hermes Agent Separa la Memoria Factual y Procedimental".

### 3.5 Conectividad y programación: canales, automatizaciones, directorio de trabajo

- **Canales** determinan qué puntos de entrada recibe el Agent y dónde se entregan los resultados.
- **Automatizaciones** determinan qué trabajo completa cuando no estás preguntando nada.
- **El directorio de trabajo** determina dónde viven las entradas y salidas de las tareas y dónde se sitúa el límite.

Los tres son configuración de capa de Agent, independientes de qué modelo está activo actualmente.

---

## 4. ¿Por qué es necesario desacoplar: cuatro razones prácticas

Separar el modelo del Agent no es purismo arquitectónico. Produce beneficios concretos.

**Razón uno: los modelos mejoran mucho más rápido que los activos personales se acumulan.** Un modelo significativamente más fuerte puede lanzarse en meses, mientras que tu memoria compartida, preferencias y flujos de trabajo se construyen lentamente. Si los dos estuvieran acoplados, cada actualización costaría esa acumulación — y los usuarios simplemente se negarían a actualizar.

**Razón dos: diferentes tareas necesitan diferentes modelos.** La redacción rápida y el razonamiento pesado no son necesariamente el mismo modelo. El desacoplamiento te permite cambiar por tarea en lugar de mantener un Agent separado, con una memoria separada, para cada tipo de trabajo.

**Razón tres: la disponibilidad del proveedor nunca está garantizada.** Cuando un proveedor limita la tasa, produce errores o cambia la política, necesitas moverte a otro modelo configurado inmediatamente. Si la memoria estuviera ligada al modelo, ese cambio llevaría un costo inaceptable.

**Razón cuatro: la propiedad se vuelve sin ambigüedad.** Porque la memoria y las Skills viven en archivos y directorios independientes, son **tus activos** en lugar de un accesorio de un modelo particular. Es lo que hace que la frase "entrenar tu propio Agent" tenga sentido en primer lugar.

---

## 5. ¿Qué ocurre realmente cuando cambias de modelos en LightVela

Las secciones anteriores describen el mecanismo. Esta una describe el comportamiento real del producto.

**Un Agent utiliza exactamente un modelo activo a la vez.** Cambiar de modelo significa seleccionar qué modelo configurado está actualmente activo — no crea un nuevo Agent. No necesitas múltiples Agents solo para usar múltiples modelos.

**Cambiar de modelo no borra la memoria, archivos de almacenamiento en la nube, Skills ni configuración de automatización.** Un cambio de modelo cambia solo el motor utilizado para las respuestas subsiguientes. No mueve el historial de chat, no reescribe archivos en almacenamiento en la nube ni altera la configuración de Skills y automatización.

**Preparación y confirmación de un cambio**, siguiendo el flujo documentado:

1. Confirma que el modelo objetivo ya está configurado y disponible para tu cuenta. Si no está configurado aún, completa la configuración del modelo primero.
2. Prepara un mensaje de prueba corto para verificar que el nuevo modelo responda normalmente.
3. Después de cambiar, envía ese mensaje de prueba en el chat y confirma tanto que el Agent responda como que la consola muestre el modelo que seleccionaste.
4. Si la primera respuesta después del cambio es ligeramente lenta, espera brevemente e inténtalo una vez antes de cambiar algo más.

**Una corrección a un malentendido común**: la configuración de una automatización consiste en nombre, programación (días fijos de la semana, intervalo fijo o una sola vez — elige uno), instrucciones de tarea, ventana de tiempo activa y canales de notificación. **No existe un campo "anclar esta automatización a un modelo específico".** Por lo tanto, el consejo de que debes pasar por tus automatizaciones y resincronizar su modelo después de cambiar no aplica. Lo que vale la pena revisar después de un cambio es la calidad de la salida de la tarea, no un campo de modelo que no existe.

---

## 6. ¿Por qué "se siente diferente" después

Este es el paso más a menudo mal diagnosticado como amnesia. Un cambio en el comportamiento y una pérdida de datos son problemas diferentes, y confundirlos te lleva por el camino de depuración incorrecto.

Los modelos difieren genuinamente a lo largo de estas dimensiones:

| Dimensión | ¿Cómo se manifiesta | Comúnmente malinterpretado como |
|---|---|---|
| Seguimiento de instrucciones | Aplica restricciones de `SOUL.md` más holgadamente o estrictamente | "Su personalidad cambió" |
| Compresión de contexto | Ofrece menos información de fondo | "Olvidó lo que discutimos" |
| Preferencia de verbosidad | Respuestas notablemente más cortas o largas | "Se volvió más tonto / más verboso" |
| Tendencia de llamada de herramienta | Lee archivos o busca proactivamente más o menos a menudo | "Dejó de usar herramientas" |
| Estilo lingüístico | Diferente redacción, tratamiento y tono | "Se convirtió en otra persona" |

La prueba es sencilla: **pregunta sobre un hecho que estás seguro que debe saber**. Si antes le dijiste un nombre de proyecto específico o una preferencia, pregunta exactamente eso después de cambiar. Si responde correctamente, la capa de memoria está intacta y estás viendo una diferencia de estilo. Si realmente no puede responder, entonces ve a verificar si los archivos de memoria y las entradas siguen ahí.

Una regla práctica: **cambia un factor a la vez y prueba después de cada cambio**. Cambiar el modelo, editar la personalidad y añadir una Skill juntos te deja sin poder decir qué capa causó el problema.

---

## 7. ¿Cuándo vale la pena cambiar de modelos

Elegir por necesidad es más útil que perseguir el modelo que actualmente se llama más fuerte.

| Tu necesidad | Enfoque recomendado |
|---|---|
| Bocetos más rápidos | Elige un modelo configurado adecuado para trabajo corto y rutinario |
| Razonamiento más fuerte o ayuda de programación | Elige el modelo que configuraste para ese tipo de trabajo |
| Un proveedor no está disponible o tiene límites de tasa | Cambia a otro modelo configurado y prueba en el chat |
| Comparar calidad de salida | Usa el mismo mensaje de prueba corto después de cada cambio, luego compara |

Si el Agent no puede funcionar después de cambiar, depura en este orden: confirma que las credenciales y configuración del proveedor del modelo objetivo estén completas → confirma que el modelo está disponible para tu cuenta con cuota suficiente → prueba con un modelo conocido que funciona → si sigue fallando, revisa los registros recientes en Diagnostics.

---

## 8. El enfoque de LightVela: modelos como una opción, activos mantenidos por el usuario

Hermes desacopla el modelo del Agent en el nivel de mecanismo, pero aún apunta a personas cómodas gestionando archivos Markdown y un entorno local directamente. La dirección de LightVela es hacer que ese desacoplamiento sea la experiencia de producto por defecto:

- **El modelo es una configuración conmutable**, no una decisión única bloqueada en la configuración.
- **La memoria, Skills, almacenamiento en la nube y automatizaciones son activos de usuario** que se mantienen estables a través de cambios de modelo, por lo que actualizar nunca significa empezar de nuevo.
- **Los cambios son verificables**: la consola muestra el modelo activo y un solo mensaje de prueba en el chat confirma que el cambio funcionó.
- **Los fallos son rastreables**: Diagnostics mantiene registros recientes, que es cómo determinas si el problema radica en el modelo, la configuración o la tarea misma.

El resultado es que el progreso del modelo llega directamente a ti, mientras que lo que ya has acumulado nunca se convierte en el precio de ese progreso.

---

## Puntos clave

- Un Agent tiene al menos tres capas: una capa de modelo reemplazable, un tiempo de ejecución de larga duración y activos a largo plazo acumulados continuamente.
- La capa de modelo maneja interpretación, planificación, llamadas de herramientas y expresión para el turno actual. No almacena preferencias, ejecuta programaciones ni gestiona canales.
- `SOUL.md`, `USER.md`, `MEMORY.md`, `memories/`, `skills/` y el directorio de trabajo todos viven fuera del modelo, por lo que cambiar de modelo no los lleva consigo.
- En LightVela, un Agent tiene un modelo activo a la vez; cambiar de modelo no borra la memoria, almacenamiento en la nube, Skills ni automatizaciones.
- Las automatizaciones no tienen configuración de "modelo anclado", por lo que la afirmación de que debes resincronizar los modelos de automatización después de cambiar es inexacta.
- Sentirse diferente después de un cambio suele venir de diferencias en el seguimiento de instrucciones, compresión de contexto y redacción — no de memoria perdida. Verifica con un hecho conocido.
