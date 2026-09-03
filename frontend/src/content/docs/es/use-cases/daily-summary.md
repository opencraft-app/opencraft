# Cómo crear resúmenes diarios con Hermes Agent

## Resumen

**Un resumen diario gana su valor no por su longitud, sino al entregarte el contexto adecuado antes de que lo pidas, y la forma de lograrlo es transformar una revisión manual en una automatización guardada.** Necesitas cuatro elementos: un Hermes Agent en la nube con un modelo configurado, un canal conectado para recibir los resultados, Skills opcionales para recopilar información y una automatización (sus campos son nombre, horario, instrucciones de tarea, ventana de tiempo activa y canales de notificación). El éxito depende de las instrucciones de la tarea: como nadie está presente para aclarar en tiempo de ejecución, la instrucción debe llevar su propio objetivo, límites de alcance (rango de tiempo y tope de elementos), formato de salida y qué hacer cuando no hay nada que reportar. Prueba la instrucción manualmente en el chat primero, luego crea la automatización y revisa la salida después de su primera ejecución real.

![Un resumen diario entregado por Hermes Agent](../images/use-case-daily-summaries.webp)

## Para quién es esto

Este caso de uso es para personas que revisan regularmente actualizaciones de proyectos, notas, archivos o conversaciones recurrentes y desean un punto de partida más corto. Puede servir para un informe matutino personal, un resumen diario de proyectos, un registro de aprendizaje o una lista enfocada de seguimientos.

El mejor primer resumen tiene un propósito estrecho. "Resumir todo" suele ser demasiado amplio; "resaltar cambios, decisiones, bloqueos y siguientes acciones para este proyecto" es mucho más fácil de juzgar y mejorar.

## Requisitos previos

- Un Hermes Agent en ejecución y un canal conectado donde deseas recibir el resumen.

- Una configuración de modelo funcional o créditos de prueba. Consulta [Configurar Modelos](../configuration/model.md) si Hermes no puede responder.

- Una fuente clara de contexto. Esto podría ser material que pegues en una conversación, archivos que gestionas en Cloud Storage o información que una Skill confiable y relevante puede acceder.

- Un horario de automatización opcional si deseas que el resumen se ejecute sin una instrucción manual.

## Pasos / conceptos clave

### 1. Define una decisión que el resumen debe ayudarte a tomar

Comienza nombrando el momento que el resumen respalda. Por ejemplo: decidir qué trabajar primero, verificar si un proyecto está bloqueado o actualizarse después de estar ausente durante un día.

Da a Hermes una instrucción que defina tanto la fuente como la forma de salida:

```text
When I share project updates, summarize them in four sections:
what changed, decisions made, blockers, and the three next actions.
Keep it under 250 words and flag anything urgent.
```

Esto transforma una solicitud general en un formato repetible que puedes comparar día tras día.

### 2. Haz que el material de origen sea deliberado

Hermes solo puede resumir información que pueda recibir o acceder a través de las capacidades que configures. Para un flujo de trabajo manual, pega o reenvía las actualizaciones relevantes en tu conversación. Para trabajos basados en archivos, mantén los materiales organizados en [Cloud Storage](../configuration/files.md) y avisa a Hermes qué documento o carpeta es relevante para la revisión actual.

Si necesitas una fuente de datos externa, elige una Skill adecuada de una fuente confiable y confirma su comportamiento antes de usarla. [Configurar Skills](../configuration/skill.md) explica cómo las Skills extienden a Hermes más allá del chat ordinario.

![Fuentes de Cloud Storage para un resumen diario](../images/use-case-daily-summary-storage.png)

### 3. Prueba la salida en una conversación normal primero

Antes de programar nada, pide el resumen manualmente a Hermes. Verifica si las secciones son útiles, si el tono es lo suficientemente conciso y si faltan detalles importantes.

Mejoras útiles incluyen:

```text
Put deadlines first.
```

```text
Do not repeat completed work unless it affects a next action.
```

```text
End with one question I should answer before tomorrow.
```

La página [Chat](../configuration/agent-chat.md) es un buen lugar para iterar sobre la instrucción antes de convertirla en una tarea recurrente.

### 4. Programa la versión que ya funciona

Cuando la instrucción manual produzca un resultado que confíes, crea una automatización. Asigna un tiempo específico e una instrucción explícita, luego selecciona un canal de notificación conectado si deseas que el resultado se entregue allí.

```text
Every weekday at 6:00 PM, prepare a daily project summary from the
updates I shared today. Include changes, blockers, and the three most
important next actions. Send it as concise bullet points.
```

Configura esto en [Automatizaciones](../configuration/automation.md). Revisa los primeros varios ejecuciones y ajusta la redacción si el resumen es demasiado amplio, demasiado largo o falta el contexto correcto.

![Una automatización de resumen diario programada](../images/use-case-daily-summary-automation.png)

## Preguntas frecuentes

### ¿Puede Hermes resumir cualquier información automáticamente?

Solo la información que Hermes pueda recibir en una conversación, acceder a través de los archivos y Skills que hayas configurado, o obtener a través del flujo de trabajo que hayas establecido. Mantén las fuentes explícitas y usa Skills confiables para cualquier acceso externo.

### ¿Por qué mi resumen es demasiado genérico?

La instrucción probablemente es demasiado amplia. Nombra al público objetivo, la fuente, el rango de tiempo y las secciones de salida. Pedir decisiones, bloqueos y siguientes acciones suele producir un resultado más accionable que pedir un resumen general.

### ¿Debería programar el resumen inmediatamente?

No. Prueba la instrucción manualmente primero. Una vez que puedas reconocer un buen resultado, programarlo ahorra tiempo sin fijar un formato no útil.

### ¿Qué pasa si el resumen no llegó?

Revisa el estado de la automatización y el canal de notificación, luego confirma que Hermes aún pueda responder en una conversación normal. Si es necesario, revisa [Diagnósticos](../configuration/diagnostics.md) antes de crear otra tarea.

## Siguientes pasos

- [Cloud Storage](../configuration/files.md) — organiza los archivos que respaldan una revisión repetible.

- [Configurar Skills](../configuration/skill.md) — añade una capacidad confiable cuando tu resumen necesita una fuente de información específica.

- [Automatizaciones](../configuration/automation.md) — entrega tu resumen probado en un horario.
