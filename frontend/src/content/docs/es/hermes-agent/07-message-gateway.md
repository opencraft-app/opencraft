## Resumen

Un **Agent** puede aparecer en varias aplicaciones de mensajería porque las aplicaciones son solo puntos de entrada — el Agent es lo que realmente funciona. El pasarela de mensajes realiza tres tareas: normaliza estructuralmente mensajes diferentes de Telegram, WhatsApp, Discord, Slack, WeChat y otros en un formato de solicitud único; enruta cada solicitud al mismo Agent basado en su configuración de conexión, en lugar de clonar una personalidad y memoria por plataforma; y después de la ejecución, devuelve el resultado a la conversación exacta de la que vino. Como la identidad (`SOUL.md`), la memoria (`USER.md`, `MEMORY.md`), las Skills (`skills/`) y las tareas programadas viven fuera de la capa de canal, algo que mencionaste en Telegram sigue siendo conocido cuando sigues el hilo en WhatsApp. Sin embargo, lo unificado no significa ilimitado: cada canal tiene su propio flujo de autorización, formato de mensaje y límites de entrega; el conjunto de canales soportados difiere entre las regiones global y China; y después de conectar un nuevo canal, debes enviar un mensaje de prueba para confirmar que las respuestas llegan a la conversación esperada.

---

## El escenario que resuelve

Imagina un día de uso. En Telegram, pides a tu Agent que resuma dónde está un proyecto. Al mediodía, saliendo, sigues el hilo en WhatsApp: "¿cuál fue el riesgo en la segunda opción que mencionaste?". A la noche, le pides que publique la conclusión en un canal de equipo de Slack o Discord.

Si esas tres interacciones se comportaran como tres bots no relacionados, el acceso multiplataforma sería inútil — tendrías que reexplicar el contexto cada vez. La forma útil es diferente: tres puntos de entrada, un asistente.

La dificultad aquí comúnmente se malinterpreta como "integrar varias más APIs". La integración de APIs es solo el trabajo superficial. El problema real es este: **hacer que cada punto de entrada resuelva a la misma identidad y contexto, sin romper las reglas propias de cada plataforma**. El pasarela de mensajes es la capa que resuelve esa tensión.

---

## 1. Primero, una corrección: un canal no es un Agent

Esta distinción es el requisito previo para todo lo demás.

| Concepto | ¿Qué es | Cardinalidad |
|---|---|---|
| **Canal** | Un punto de entrada para mensajes, ej. Telegram, WhatsApp, Discord, Slack, WeChat | Un Agent puede conectar muchos |
| **Agent** | El sujeto de trabajo persistente que mantiene identidad, memoria, Skills, tareas | Compartido por muchos canales |

La gente instintivamente trata "mi bot de Telegram" como una entidad independiente, lo que naturalmente plantea la pregunta "¿entonces mi bot de WhatsApp es uno diferente?". Una vez que se entienden los canales como puntos de entrada y no como sujetos, la pregunta se disuelve.

La ruta completa se ve así:

```text
Messaging apps (multiple entry points)
    ↓  platform-native messages
Message gateway (normalise / route / deliver)
    ↓  unified request
The same Hermes Agent
    ↓
model inference + tool execution + memory recall + skill loading
    ↓  execution result
Message gateway
    ↓  delivered in platform format
Original conversation on the original channel
```

Tenga en cuenta el paso final — *la conversación original en el canal original*. Eso no es un pie de nota; es uno de los problemas centrales que la pasarela debe obtener exactamente bien, cubierto más abajo.

---

## 2. Tarea uno de la pasarela: recibir y normalizar

Las plataformas difieren en casi todas las dimensiones:

- **Identificadores de usuario diferentes** — IDs numéricos, números de teléfono o nombres de usuario internos de la plataforma.
- **Identificadores de conversación diferentes** — mensajes directos, grupos, canales y hilos se representan de manera diferente.
- **Estructuras de mensaje diferentes** — texto, imágenes, voz, archivos, respuestas citadas y reacciones tienen sus propios diseños de campos.
- **Modelos de eventos diferentes** — algunos empujan mediante webhooks, otros necesitan una conexión persistente o polling.

Si el Agent enfrentara estas diferencias directamente, la ramificación específica de la plataforma se extendería por su núcleo, y cada nueva plataforma significaría tocar la lógica central. La normalización confina esas diferencias a la pasarela: los mensajes nativos de la plataforma se convierten en una solicitud uniforme, así que el Agent solo necesita entender una forma de entrada única.

El beneficio práctico: **agregar un canal no debería requerir cambiar la lógica de identidad, memoria o Skills**. El Agent se preocupa por lo que se preguntó, no por el diseño de campos de la aplicación que lo transportó.

---

## 3. Tarea dos de la pasarela: enrutar al mismo Agent

Este es el paso que hace posible "una personalidad en todas las plataformas".

Una vez que la solicitud se normaliza, la pasarela usa su **configuración de conexión** para determinar a qué Agent pertenece, y luego entrega la solicitud a ese Agent. No inicia una nueva personalidad ni almacén de memoria solo porque el mensaje llegó de una plataforma recién conectada.

Esto importa porque decide si los activos a largo plazo se comparten o se fragmentan:

| Activo | ¿Dónde vive | Comportamiento entre canales |
|---|---|---|
| Identidad y reglas de comportamiento | `SOUL.md` | Una copia, compartida por todos los canales |
| Perfil de usuario | `USER.md` | Una copia, compartida por todos los canales |
| Hechos entre sesiones | `MEMORY.md` / `memories/` | Una copia, compartida por todos los canales |
| Métodos capturados | `skills/` | Una copia, compartida por todos los canales |
| Tareas programadas | Configuración de capa de Agent | Desacoplado de los canales; objetivo de entrega configurable |

Como todos estos se sitúan fuera de la capa de canal, "sigue sabiendo el nombre del proyecto que mencioné en Telegram" no es una característica de sincronización que alguien tuvo que construir — es una consecuencia natural de que solo haya una copia.

Es la misma lógica de desacoplamiento que "cambiar modelos no pierde memoria": **separe la capa de acceso volátil de la capa de activos estables**. Para la versión del lado del modelo de este argumento, vea "¿Puede el cerebro de un Hermes Agent ser reemplazado? Capa de Modelo vs Capa de Agent".

---

## 4. Tarea tres de la pasarela: entregar de nuevo al lugar correcto

Una vez que el Agent termina, la pasarela envía el resultado de vuelta. "Enviarlo de vuelta" es más difícil de lo que parece, porque debe responder correctamente tres preguntas al mismo tiempo:

1. **¿Qué plataforma** — un mensaje de Telegram debe devolverse a Telegram, no a WhatsApp.
2. **¿Qué conversación** — en una plataforma puede tener mensajes directos más varios grupos y canales. Responder a la conversación incorrecta no es meramente incómodo; en un contexto de grupo puede filtrar información.
3. **¿Qué formato** — las plataformas difieren en límites de longitud de mensaje, soporte de Markdown, cómo se envían imágenes y archivos, y si existen respuestas citadas. El mismo contenido necesita una presentación diferente por plataforma.

El segundo punto merece énfasis. **Los objetivos de entrega incorrectos son la clase de problema de mayor severidad en configuraciones multi-canal**: contenido privado publicado en un grupo, o la conclusión de un equipo enviada al canal de otro equipo. Es exactamente por eso que cada nuevo canal conectado debe verificarse con un mensaje de prueba en una conversación segura primero.

---

## 5. Lo unificado no significa ilimitado

"Un Agent, múltiples puntos de entrada" es fácil de leer como "todas las plataformas se comportan idénticamente". En realidad, cada canal mantiene sus propias restricciones, y compartir un Agent no elimina ellas.

### 5.1 La autorización difiere

Cada plataforma tiene su propio flujo de conexión y forma de credenciales: algunos requieren crear un bot en un portal de desarrollador y copiar un token, algunos requieren escanear un código QR, algunos requieren un AppID y AppSecret. En otras palabras, **conectar cada canal es un paso de autorización independiente** — una configuración no los cubre a todos.

### 5.2 Los canales soportados difieren por región

Esto es una trampa fácil al leer la documentación: los canales global y China de LightVela no soportan el mismo conjunto de canales. El orden de canales global es Telegram, WhatsApp, Discord, Slack, WeChat, QQ, WeCom, Lark. La región China soporta WeChat, QQ, WeCom, Lark y DingTalk.

Así que cuando veas una afirmación como "Telegram es soportado", confirma a qué región se aplica en lugar de asumir que se lleva a cabo.

### 5.3 El contexto de grupo difiere de los mensajes directos

En un mensaje directo, el Agent se enfrenta a una persona; en un grupo se enfrenta a muchos. Los grupos añaden preguntas: ¿cuándo debe responder, cuándo debe mantenerse en silencio, qué contenido es inapropiado para expandir públicamente y quién está autorizado para desencadenar acciones sensibles. Estos pertenecen a reglas de comportamiento y diseño de permisos — la pasarela no puede decidirlos automáticamente.

### 5.4 Las capacidades de entrega difieren

Los límites de longitud de mensaje, soporte de texto rico, envío de archivos y la capacidad de citar un mensaje específico dan forma a la salida. Una respuesta larga que se renderiza limpiamente en Discord puede necesitar dividirse o simplificarse en otros lugares.

---

## 6. Un orden práctico para conectar un nuevo canal

Transformando los principios anteriores en pasos, este orden evita la mayoría de los problemas.

1. **Confirme el soporte regional** — verifique que el canal esté disponible en su región, para que no siga documentación escrita para otra.
2. **Complete la autorización del lado de la plataforma** — siga la guía de ese canal para crear un bot o conceder acceso y obtener las credenciales. Las credenciales son sensibles: nunca escribirlas en archivos de contexto a largo plazo ni peguéstelas en el chat.
3. **Conecte en el lado del producto** — ingrese las credenciales, guarde y confirme que el estado muestre como conectado.
4. **Envíe un mensaje de prueba** — use una conversación segura (un mensaje directo o un grupo de prueba) y confirme que el Agent responde.
5. **Verifique el objetivo de entrega** — verifique específicamente que la respuesta llegó a **la misma conversación desde la que se envió el mensaje**, no a otra.
6. **Verifique la memoria compartida** — pregunte sobre algo que le dijiste en un canal diferente. Una respuesta correcta prueba que este canal realmente enruta al mismo Agent.
7. **Solo entonces agregue acceso a grupos** — después de que los mensajes directos funcionen, únase a grupos y confirme que los límites de respuesta en grupo se comporten como se espera.

El paso 6 es el que la mayoría de la gente omite, y lleva el mayor valor: es la manera más directa de confirmar que los canales comparten realmente un Agent.

---

## 7. Síntomas comunes y cómo leerlos

| Síntoma | Causa más probable | Acción sugerida |
|---|---|---|
| Sin respuesta alguna en un nuevo canal | Autorización incompleta o credenciales incorrectas | Verifique el estado de conexión y las credenciales, repita la autorización |
| La respuesta aparece en una conversación diferente | Error de resolución de objetivo de entrega o configuración | Deje de usarlo en grupos; muevase a mensajes directos para aislar |
| Respuestas, pero "no me conoce" | Posiblemente conectado a un Agent diferente | Verifique con un hecho conocido y verifique a qué Agent apunta la conexión |
| Grupos en silencio, mensajes directos bien | Reglas de desencadenante en grupo o permisos | Revise las reglas de respuesta en grupo y los permisos requeridos |
| Respuestas largas truncadas o malformateadas | Límites de entrega de la plataforma | Ajuste la longitud y el formato de salida para esa plataforma |

La tercera fila merece atención: **"no me conoce" significa algo diferente aquí que después de un cambio de modelo**. Después de cambiar modelos, usualmente es una diferencia de estilo; en un canal recién conectado, más probablemente significa que este canal no apunta al Agent que asumiste. El diagnóstico es el mismo — pregunte sobre un hecho que está seguro de que debe conocer.

---

## 8. El enfoque de LightVela: canales como puntos de entrada pluggables

Hermes separa los canales del Agent en el nivel de mecanismo, pero conectar cada plataforma aún significa manejar credenciales, callbacks y tiempo de ejecución usted mismo. La dirección de LightVela es hacer de esa capa un punto de entrada productizado y pluggable:

- **Los canales son configuraciones** — conéctelos o desconéctelos bajo un Agent, sin necesidad de crear un Agent separado por plataforma.
- **Los activos se comparten por defecto** — una personalidad, conjunto de memoria, conjunto de Skills y conjunto de tareas programadas; un nuevo canal reutiliza ellos inmediatamente, sin nada que migrar.
- **El estado de conexión es visible** — la consola muestra si un canal está conectado, facilitando distinguir "nunca conectado con éxito" de "conectado pero no respondiendo".
- **Las diferencias regionales son explícitas** — la región global y China listan sus propios canales soportados, previniendo errores de región a región.
- **Los problemas son rastreables** — los registros recientes en Diagnostics ayudan a separar problemas de autorización de problemas de entrega de problemas de tarea.

---

## Puntos clave

- Los canales son puntos de entrada; el Agent es el sujeto. Muchos canales comparten un Agent en lugar de un bot por plataforma.
- La pasarela hace tres cosas: **normaliza** las diferencias de plataforma, **enruta** al mismo Agent y **entrega** de nuevo a la conversación original.
- La identidad, la memoria, las Skills y las tareas programadas viven fuera de la capa de canal, así que la continuidad entre canales es una consecuencia arquitectónica, no una característica de sincronización añadida.
- Lo unificado no significa ilimitado: la autorización, el soporte regional, el contexto de grupo y los límites de entrega difieren por canal.
- Después de conectar un canal, verifique dos cosas: que las respuestas lleguen a la conversación esperada, y que realmente comparta la misma memoria.
