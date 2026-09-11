# Potencia tu Bot de Eventos de Discord con Capacidades Agénticas de IA

## Resumen

**Un bot de eventos de Discord se vuelve más útil cuando puede explicar información de eventos aprobada, responder preguntas repetitivas, apoyar el onboarding y enviar recordatorios programados desde un único Hermes Agent configurado.** En LightVela, la ruta práctica consiste en conectar Discord, proporcionar al Agent un breve del evento y límites de seguridad, probarlo contra preguntas reales de participantes y agregar Tareas programadas estrechas para recordatorios o resúmenes.

Este patrón es ideal para torneos recurrentes, raids, grupos de estudio, lanzamientos comunitarios y otros eventos donde la misma información debe repetirse en muchas conversaciones.

![Un Agent de IA que apoya una comunidad de eventos de Discord](../images/use-case-discord-event-agent.webp)

## Para quién es esto y resultado esperado

Este caso de uso es para organizadores de eventos que pasan demasiado tiempo respondiendo preguntas sobre fechas, zonas horarias, registro, reglas, ubicaciones y recordatorios de última hora.

El resultado esperado es un asistente de eventos que mantiene las respuestas consistentes y ayuda a los organizadores a repetir la información correcta en el momento adecuado.
Debe reducir el trabajo de coordinación repetitivo sin convertirse en la fuente de verdad para decisiones que solo un organizador humano puede tomar.

## Requisitos previos

- Un Hermes Agent de LightVela en ejecución con un modelo configurado.

- Un servidor de Discord donde puedas agregar y configurar un Bot.

- Un breve de evento revisado que contenga el nombre del evento, fechas, zona horaria, pasos de registro, reglas, enlaces y canal de contacto.

- Un moderador o organizador que posea actualizaciones al calendario y apruebe anuncios.

- La [guía de configuración de canal de Discord](../configuration/channel-discord.md) y la [guía de Tareas programadas](../configuration/automation.md).

## Pasos

### 1. Convierte el breve del evento en una guía de operación para el Agent

Comienza separando los hechos que el Agent puede repetir de las acciones que requieren aprobación del organizador.
La primera categoría incluye la hora de inicio publicada, la fecha límite de registro, las reglas de elegibilidad y las ubicaciones de canal.
La segunda categoría incluye cambios en el calendario, disputas, reembolsos, prohibiciones, decisiones de premios y excepciones.

Proporciona al Agent una guía de operación concisa como:

```text
You are the event assistant for this Discord community.

Use the approved event brief for dates, time zones, registration, rules, and channel directions.
Answer in short steps and include the exact time zone when discussing schedules.
Never invent a time, rule, registration status, or announcement.
If event information is missing or has changed, direct the member to the event organizer.
Escalate disputes, moderation issues, eligibility exceptions, and prize questions to a human.
```

Mantén el breve del evento actualizado.
Un Agent de IA puede hacer más fáciles las respuestas repetidas, pero no puede hacer que un calendario desactualizado sea correcto.

### 2. Conecta el Bot de Discord y elige una superficie de operación estrecha

En LightVela, conecta el canal de Discord y completa el flujo de autorización del Portal de Desarrolladores de Discord.
Usa la [guía de configuración de Discord](../configuration/channel-discord.md) para completar la configuración:

1. Crea el Bot.

2. Habilita la Intención de Contenido de Mensaje.

3. Configura permisos de mínimo privilegio.

4. Invita al bot con permisos mínimos: Ver Canales, Enviar Mensajes y Leer Historial de Mensajes.

![Invitación de bot de Discord y selección de servidor](../images/discord-event-bot-invite.webp)

Para el primer despliegue, elige un canal de evento o una conversación de Discord compatible y pruébalo allí antes de expandir el flujo de trabajo.
Esto facilita inspeccionar respuestas, comportamiento de permisos y entrega de notificaciones.

![Configuración de permisos de Bot de Discord](../images/discord-5-global.webp)

### 3. Prueba las preguntas que realmente harán los participantes

Prueba al Agent con un conjunto pequeño de preguntas de participantes:

```text
When does the tournament start in UTC+8?

What do I need to do before joining tonight's raid?

Where do I register and when does registration close?

The schedule changed. Can you announce the new time?
```

Las primeras tres preguntas deben producir respuestas concisas y fundamentadas si el breve del evento contiene la información requerida.
La pregunta final no debe causar que el Agent invente un anuncio o cambie el calendario silenciosamente.
Debe señalar al organizador o al proceso de actualización aprobado.

### 4. Usa al Agent para el apoyo de participantes

Una vez que las respuestas principales sean confiables, usa al Agent para el apoyo de participantes repetible:

- Explica el calendario del evento en la zona horaria solicitada por el participante.

- Señala a nuevos miembros hacia el registro, reglas y canales de apoyo.

- Resume los pasos necesarios antes de unirse a un evento.

- Responde preguntas sobre reglas de elegibilidad publicadas.

- Deriva problemas sensibles a un organizador humano.

Los ejemplos de prompts podrían verse así:

```text
@YourEventBot What do I need to prepare before tonight's raid?

@YourEventBot I am new here. Which channel has the tournament rules?

@YourEventBot Can you summarize the registration steps in three bullets?
```

Usa el método de mención o conversación soportado por tu configuración de Discord objetivo.
No asumas que cada canal de servidor o modo de chat de grupo tenga el mismo comportamiento.

### 5. Agrega recordatorios programados y resúmenes

Usa una Tarea programada cuando el evento tenga un ritmo predecible.
LightVela soporta ejecuciones únicas, días fijos de la semana e intervalos fijos, así como una ventana de efectividad opcional y canales de notificación.
Puedes elegir un día fijo de la semana, un intervalo fijo o una ejecución única.
También puedes pausar, editar o eliminar una tarea programada más tarde.

![Configura una tarea automatizada para un evento de Discord](../images/automation-2-global-en.webp)

```text
One day before the tournament, remind the event channel about the start time, time zone, registration deadline, and rules channel.
Use only the approved event brief.
If the brief is missing a detail, tell the organizer which detail needs review.
```

En este ejemplo, el bot está ejecutando la tarea programada "Recordatorio de torneo de juego".

![Un bot de Discord que envía un recordatorio de torneo](../images/discord-event-reminder.webp)

También podrías programar un resumen post-evento para organizadores:

```text
After the event, summarize the published results, unanswered participant questions, and issues that need moderator review.
Do not infer winners, penalties, or policy decisions from incomplete information.
```

Revisa la primera salida programada antes de agregar una serie de recordatorios.
La [guía de configuración de Tarea programada](../configuration/automation.md) explica dónde establecer el calendario, instrucciones de tarea, ventana de efectividad y configuración de notificaciones.

## Lista de verificación práctica

| Etapa del evento | Acción | Componente de LightVela | Resultado esperado o señal de fallo |
| --- | --- | --- | --- |
| Antes del lanzamiento | Agrega el calendario revisado, zona horaria, reglas, enlaces y ruta de escalada | Contexto del Agent | Los participantes pueden obtener la misma respuesta aprobada |
| Conexión | Invita el Bot y pruébalo en la conversación intencionada | Canal de Discord | El Bot responde y solo tiene los permisos que necesita |
| Apoyo de participantes | Pregunta sobre calendario, registro y preparación | Hermes Agent | Las respuestas son concisas, específicas y fundamentadas en el breve |
| Recordatorio | Programa un mensaje pre-evento | Tarea programada | El mensaje llega en el canal seleccionado en la hora esperada |
| Después del evento | Genera un resumen para organizadores | Tarea programada o Chat | El resumen separa resultados conocidos, preguntas abiertas y seguimiento humano |

## Validación y límites

Valida el flujo de evento con cuatro pruebas:

1. Pide un detalle de calendario conocido y confirma que la zona horaria sea explícita.

2. Pide un paso de registro y confirma que el Agent señale al canal o enlace correcto.

3. Pregunta sobre una regla intencionalmente omitida y confirma que el Agent admita que no lo sabe.

4. Pide un cambio de calendario o decisión de moderación y confirma que el Agent escalada en lugar de decidir.

La documentación actual del canal de Discord cubra autorización de Bot, interacción de servidor y canal, acceso a contenido de mensaje y mensajes proactivos en la capa de canal.
También nota una limitación actual alrededor del soporte de chat de grupo.
Confirma el comportamiento exacto de mención y de interacción multiusuario en tu servidor objetivo antes de prometer un asistente de evento basado en @mention amplio.

El Agent no debe confiar para aprobar participantes, emitir penalizaciones, resolver disputas, anunciar cambios de calendario sin revisar o manejar secretos.
Los organizadores humanos permanecen responsables de la fuente de verdad oficial del evento.

## Preguntas frecuentes

### ¿Puede el Agent responder preguntas de evento en diferentes zonas horarias?

Puede explicar una hora de evento publicada cuando el breve del evento incluye la zona horaria de origen y el participante proporciona una zona horaria objetivo.
Pídele que incluya tanto la hora original como la hora convertida para que los participantes puedan verificar el resultado.

### ¿Puede una Tarea programada enviar un recordatorio de evento de Discord?

Sí, la documentación del canal de Discord lista mensajes proactivos como soportados en la capa de canal.
Crea una Tarea programada con el texto del recordatorio, calendario, ventana de efectividad y canal de notificación, luego prueba la primera entrega antes de confiar en ella para una fecha límite crítica.

### ¿Puede el Agent actualizar el calendario del evento por sí mismo?

No.
Debe repetir el calendario aprobado y derivar cambios propuestos al organizador.
Actualiza el breve del evento y revisa la siguiente respuesta antes de publicar una hora cambiada.

### ¿Esto es un reemplazo para un bot de evento personalizado?

No siempre.
LightVela es una buena opción cuando la necesidad principal es Q&A en lenguaje natural, orientación de evento fundamentada y comunicación programada.
Un bot personalizado puede ser mejor para comandos altamente específicos, registro respaldado por base de datos, gestión de llaves o flujos de facturación externos.

## Conclusión

Proporciona al Agent un breve de evento revisado, conéctalo a Discord, prueba preguntas reales de participantes y agrega una Tarea programada estrecha para recordatorios o resúmenes.
Esa secuencia agrega comportamiento útil de Agent de IA a un bot de evento mientras deja la autoridad del evento, cambios de política y decisiones sensibles con los organizadores humanos.

Para el patrón de comunidad más amplio, consulta [Conoce a LightVela para Discord: Tu Bot de Discord de IA que Siente tu Canal](./discord-community-agent.md).
