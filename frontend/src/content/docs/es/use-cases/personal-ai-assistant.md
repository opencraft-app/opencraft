# Cómo construir un asistente personal de IA con LightVela

## Resumen

**Empiece su asistente de IA personal creando y seleccionando un Bot y comprobando una respuesta en el chat web con créditos de modelo disponibles o un modelo configurado. Conecte un canal de mensajería solo si quiere usar esa aplicación. Después, pruebe una preferencia estable entre conversaciones, añada una Skill para una tarea concreta y programe una tarea cuando sus instrucciones ya funcionen. La memoria, las Skills, los canales y las tareas se gestionan para el Bot seleccionado.**

![Nueva conversación de Web Chat en la consola internacional de LightVela](../../images/use-case-personal-ai-assistant.webp)

## Para quién es esto

Esta configuración funciona bien si desea un solo asistente para la planificación diaria, seguimientos de investigación, recordatorios y preguntas que se benefician de conocer sus preferencias. No necesita un flujo de trabajo complejo. Comience con un solo Hermes Agent y un canal que ya revisa regularmente.

Es especialmente útil cuando se encuentra repitiendo contexto como su zona horaria, el formato que prefiere para los resúmenes, los proyectos en los que está trabajando o el tipo de ayuda que desea cada mañana.

## Requisitos previos

- Una cuenta de LightVela y un Hermes Agent en funcionamiento. Si aún no ha creado uno, comience con el [Quickstart](../02-quickstart.md).

- El chat web basta para empezar. Si prefiere una aplicación de mensajería, conecte un canal siguiendo las instrucciones que aparecen a continuación.

- Una configuración de modelo funcional o créditos de prueba disponibles. Consulte [Configure Models](../configuration/model.md) si Hermes aún no puede responder.

- Una breve idea de lo que desea ayuda con primero. Una sola rutina, como planificar su día o recopilar seguimientos, es suficiente.

## Pasos / conceptos clave

### 1. Darle a Hermes un lugar en su rutina diaria

Seleccione el avatar del Bot deseado en la barra de Bots. En pantallas estrechas, abra primero el panel de navegación. Compruebe su nombre antes de cambiar modelos, memoria, Skills, canales o tareas programadas. El chat web y la lista de conversaciones pertenecen al Bot seleccionado; los Bots adicionales también pueden usar el chat web. No necesita conectar un canal de mensajería para usarlo.

El chat web basta para empezar. Si prefiere una aplicación de mensajería, conecte un canal siguiendo las instrucciones que aparecen a continuación.

Si desea usar una aplicación de mensajería, conecte un canal y compruebe que el Bot responde allí. Consulte la guía de [Telegram](../configuration/channel-telegram.md), [WhatsApp](../configuration/channel-whatsapp.md), [Discord](../configuration/channel-discord.md), [WeChat](../configuration/channel-wechat.md), [Slack](../configuration/channel-slack.md).

![La página de Canal en la consola de LightVela](../../images/personal-ai-assistant-channel.webp)

Comience con una introducción clara en lugar de una solicitud amplia. Por ejemplo:

```text
I want you to be my personal planning assistant. I am in Singapore time.
Keep daily plans short, call out deadlines first, and ask one follow-up question when something is unclear.
```

### 2. Que la memoria lleve el contexto que se repite

Hermes construye contexto útil con el tiempo, por lo que no necesita restablecer cada preferencia en cada conversación. Dígale los hechos y preferencias de trabajo que deben permanecer útiles: su zona horaria, cómo desea que se estructura un resumen, nombres de proyectos importantes o los días que prefiere planificar por adelantado.

También puede declarar la solicitud directamente:

```text
Remember that I prefer a concise weekday briefing at 8:00 AM,
with meetings, deadlines, and the three most important next actions.
```

Utilice la página de [Memory Management](../configuration/memory.md) para revisar la memoria y la información de perfil de usuario que Hermes ha acumulado. La memoria debe reducir la repetición, no convertirse en un lugar de vertido para cada detalle que pase.

Recordar que prefiere un resumen los días laborables a las 8:00 no crea una tarea programada. Configure el horario por separado, verifique la primera ejecución y compruebe la entrega en el canal de notificaciones elegido.

### 3. Agregar una Skill solo cuando una tarea real lo requiera

Hermes puede charlar sin Skills adicionales. Agregue una cuando pueda nombrar el trabajo práctico que debe ayudar, como buscar información, organizar una lista de tareas o preparar un informe recurrente. Esto mantiene al asistente comprensible y más fácil de confiar.

![La página de Skills en la consola de LightVela](../../images/personal-ai-assistant-skills.webp)

Navegue por una opción adecuada en ClawHub, luego utilice [Configure Skills](https://lightvela.ai/docs/configuration/skill) para instalarla. Antes de instalar algo, lea su descripción y elija fuentes que confíe.

### 4. Convertir una conversación útil en una revisión repetible

Una vez que un prompt sea confiablemente útil, decida si debe ejecutarse en un horario. Una tarea programada simple puede pedirle a Hermes un plan matutino, una revisión al final del día o un reinicio semanal sin que tenga que recordar iniciar la conversación.

Por ejemplo:

```text
Every weekday at 8:00 AM, prepare a concise plan for today.
Start with deadlines and meetings, then suggest three focused next actions.
```

Establezca el horario y el canal de notificación en [Tareas programadas](../configuration/automation.md). Mantenga la primera tarea programada pequeña; puede refinar la instrucción después de haber visto unos pocos resultados reales.

![Plantillas oficiales en la página Tareas programadas de LightVela](../../images/personal-ai-assistant-automations.webp)

## Comprobar cada capa

| Capa | Comprobación | Límite |
| --- | --- | --- |
| Bot y chat web | Seleccione el Bot deseado y envíe un mensaje breve | Las respuestas requieren un Bot en línea y créditos o una configuración de modelo utilizable |
| Memoria | Indique una preferencia estable, abra una conversación nueva y compruébela | Una conversación nueva no borra la memoria a largo plazo |
| Tarea programada | Revise el horario, el canal de notificación y el resultado | Crear o copiar un Bot no copia las tareas programadas ni las conexiones de canales |

## Verificar el resultado

Compruebe una respuesta en el chat web antes de conectar un canal. Pruebe una preferencia recordada en una conversación nueva y revise el primer resultado programado. Si falla un canal o una tarea, compruebe el Bot seleccionado, su configuración y su estado antes de añadir más funciones.

## Preguntas frecuentes

### ¿Necesito configurar cada característica antes de que Hermes sea útil?

El chat web basta para empezar. Si prefiere una aplicación de mensajería, conecte un canal siguiendo las instrucciones que aparecen a continuación.

### ¿Recordará Hermes cada mensaje que envíe?

No. La memoria está destinada a la información que permanece útil entre conversaciones, como preferencias, trabajo recurrente y contexto estable. Puede pedirle a Hermes que recuerde u olvide información cuando sea necesario, luego revise la en Memory Management.

### ¿Puedo usar el mismo asistente desde más de un canal?

Sí, si esos canales están conectados al mismo Bot. La memoria a largo plazo y las preferencias pertenecen a ese Bot. Otro Bot tiene su propio espacio de trabajo: copiarlo proporciona un estado inicial, sin sincronizar los cambios posteriores.

### ¿Qué debería automatizar primero?

Elija una tarea que ya repita en un horario predecible. La planificación matutina, una revisión diaria breve o una verificación de prioridades semanal son buenos primeros candidatos porque puede determinar rápidamente si la salida está ayudando.

## Conclusión

Centre el primer asistente en una rutina. Cuando el chat, la memoria y la primera tarea programada funcionen para el Bot seleccionado, amplíe sus responsabilidades gradualmente.
