# Cómo construir un asistente personal de IA con LightVela

## Resumen

**El orden correcto para construir un asistente personal de IA no es automatizar todo de una vez. Comience haciendo que un Hermes Agent en la nube sea accesible en la aplicación de chat que ya utiliza, luego capas de memoria, Skills y automatizaciones.** Cada uno de los cinco bloques de construcción resuelve un problema: el modelo determina la calidad del razonamiento, el canal determina dónde lo accede, la memoria le permite retener cómo trabaja, las Skills le dan métodos reutilizables y las automatizaciones le permiten completar trabajos acordados mientras usted está ausente. Durante la primera semana, haga solo tres cosas: configure un modelo, conecte un canal y verifique que la memoria persista realmente entre sesiones. Una vez que esta ruta sea confiable, agregue Skills y automatizaciones; de esta manera, cuando algo falle, podrá indicar qué capa lo causó.

![Un asistente personal de IA con LightVela a través de varios canales](../images/use-case-personal-ai-assistant.webp)

## Para quién es esto

Esta configuración funciona bien si desea un solo asistente para la planificación diaria, seguimientos de investigación, recordatorios y preguntas que se benefician de conocer sus preferencias. No necesita un flujo de trabajo complejo. Comience con un solo Hermes Agent y un canal que ya revisa regularmente.

Es especialmente útil cuando se encuentra repitiendo contexto como su zona horaria, el formato que prefiere para los resúmenes, los proyectos en los que está trabajando o el tipo de ayuda que desea cada mañana.

## Requisitos previos

- Una cuenta de LightVela y un Hermes Agent en funcionamiento. Si aún no ha creado uno, comience con el [Quickstart](https://lightvela.ai/docs/quickstart).

- Un canal de conversación. Telegram, WhatsApp, Discord, Slack y WeChat son puntos de partida comunes; elija el uno con el que sea más probable que abra cada día.

- Una configuración de modelo funcional o créditos de prueba disponibles. Consulte [Configure Models](https://lightvela.ai/docs/configuration/model) si Hermes aún no puede responder.

- Una breve idea de lo que desea ayuda con primero. Una sola rutina, como planificar su día o recopilar seguimientos, es suficiente.

## Pasos / conceptos clave

### 1. Darle a Hermes un lugar en su rutina diaria

Conecte un canal de mensajería y luego envíe los primeros mensajes desde el mismo lugar donde normalmente organiza su día. El canal no es solo un método de entrega; es el hábito que hace que el asistente sea fácil de volver a utilizar. Siga la página de configuración para [Telegram](https://lightvela.ai/docs/configuration/channel-telegram), [WhatsApp](https://lightvela.ai/docs/configuration/channel-whatsapp), [Discord](https://lightvela.ai/docs/configuration/channel-discord), [Slack](https://lightvela.ai/docs/configuration/channel-slack) o [WeChat](https://lightvela.ai/docs/configuration/channel-wechat).

![La página de Canal en la consola de LightVela](../images/personal-ai-assistant-channel.webp)

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

Utilice la página de [Memory Management](https://lightvela.ai/docs/configuration/memory) para revisar la memoria y la información de perfil de usuario que Hermes ha acumulado. La memoria debe reducir la repetición, no convertirse en un lugar de vertido para cada detalle que pase.

### 3. Agregar una Skill solo cuando una tarea real lo requiera

Hermes puede charlar sin Skills adicionales. Agregue una cuando pueda nombrar el trabajo práctico que debe ayudar, como buscar información, organizar una lista de tareas o preparar un informe recurrente. Esto mantiene al asistente comprensible y más fácil de confiar.

![La página de Skills en la consola de LightVela](../images/personal-ai-assistant-skills.webp)

Navegue por una opción adecuada en ClawHub, luego utilice [Configure Skills](https://lightvela.ai/docs/configuration/skill) para instalarla. Antes de instalar algo, lea su descripción y elija fuentes que confíe.

### 4. Convertir una conversación útil en una revisión repetible

Una vez que un prompt sea confiablemente útil, decida si debe ejecutarse en un horario. Una automatización simple puede pedirle a Hermes un plan matutino, una revisión al final del día o un reinicio semanal sin que tenga que recordar iniciar la conversación.

Por ejemplo:

```text
Every weekday at 8:00 AM, prepare a concise plan for today.
Start with deadlines and meetings, then suggest three focused next actions.
```

Establezca el horario y el canal de notificación en [Automations](https://lightvela.ai/docs/configuration/automation). Mantenga la primera automatización pequeña; puede refinar la instrucción después de haber visto unos pocos resultados reales.

![La página de Automatizaciones en la consola de LightVela](../images/personal-ai-assistant-automations.webp)

## Preguntas frecuentes

### ¿Necesito configurar cada característica antes de que Hermes sea útil?

No. Un canal y un modelo funcional son suficientes para comenzar. Agregue memoria, Skills y automatizaciones gradualmente a medida que descubra qué tareas repetidas valen la pena mantener.

### ¿Recordará Hermes cada mensaje que envíe?

No. La memoria está destinada a la información que permanece útil entre conversaciones, como preferencias, trabajo recurrente y contexto estable. Puede pedirle a Hermes que recuerde u olvide información cuando sea necesario, luego revise la en Memory Management.

### ¿Puedo usar el mismo asistente desde más de un canal?

Sí. Varios canales conectados pueden apuntar al mismo Hermes Agent, por lo que el asistente puede retener el mismo contexto mientras se mueve entre plataformas de mensajería compatibles.

### ¿Qué debería automatizar primero?

Elija una tarea que ya repita en un horario predecible. La planificación matutina, una revisión diaria breve o una verificación de prioridades semanal son buenos primeros candidatos porque puede determinar rápidamente si la salida está ayudando.

## Próximos pasos

- [Chat](https://lightvela.ai/docs/configuration/agent-chat) — trabaje con Hermes directamente en la consola.

- [Memory Management](https://lightvela.ai/docs/configuration/memory) — revise lo que su asistente retiene entre conversaciones.

- [Automations](https://lightvela.ai/docs/configuration/automation) — programe las rutinas que demuestran ser útiles.
