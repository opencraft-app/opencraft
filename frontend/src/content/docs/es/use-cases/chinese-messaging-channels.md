# Cómo conectar un Agent de IA a plataformas de mensajería

## Resumen

**Conectar un Hermes Agent a plataformas de mensajería se basa en una idea simple: los canales son los puntos de entrada, y el Agent es lo que funciona. Un Agent en la nube comparte el mismo modelo, Skills y memoria entre todos los canales conectados, por lo que no es necesario crear un bot separado por plataforma.** El flujo consta de cuatro pasos: confirmar que el canal está disponible en su región (la región global soporta Telegram, WhatsApp, Discord, Slack, WeChat, QQ, WeCom y Lark; la región China soporta WeChat, QQ, WeCom, Lark y DingTalk); completar la autorización en el lado de la plataforma para obtener credenciales; conectar en el consola y confirmar que el canal aparece como conectado; luego enviar un mensaje de prueba y verificar que la respuesta llegue a la misma conversación desde la que se envió el mensaje. Las credenciales son sensibles: nunca escribirlas en el contexto a largo plazo ni pegués en el chat.

![Conexiones de plataforma de mensajería de LightVela](../images/use-case-messaging-platforms.webp)

## Para quién es este documento

Esta guía es para cualquier persona que desee hablar con Hermes desde una aplicación de mensajería en lugar de solo desde la consola web. También le será de ayuda si desea tener un asistente disponible en más de un lugar, por ejemplo, Telegram para uso personal y Discord para una comunidad.

Comience con un solo canal. Añada otro solo cuando sirva un contexto distinto, audiencia diferente o hábito de dispositivo.

## Requisitos previos

- Una cuenta de LightVela con un Hermes Agent que esté en ejecución. Utilice [Quickstart](../02-quickstart.md) si necesita crear uno.

- Una configuración de modelo funcional o créditos de prueba, para que Hermes pueda responder después de conectar el canal.

- Acceso a la plataforma que desea conectar. Algunas plataformas utilizan un flujo de autorización con código QR, mientras que otras requieren un token de bot o credenciales de plataforma.

- Un mensaje de prueba que pueda enviar tan pronto como finalice la configuración.

## Pasos / conceptos clave

### 1. Elija el canal que coincida con la conversación

Elija según donde realmente utilizará el asistente, no según el número de plataformas a las que puede conectar. Telegram, WhatsApp, Discord, Slack y WeChat son opciones comunes:

| Canal | Buen ajuste para |
| --- | --- |
| Telegram | Mensajería personal, rutinas ligeras y conversaciones directas |
| WhatsApp | Comunicación cotidiana y notificaciones donde WhatsApp ya sea su opción por defecto |
| Discord | Comunidades, grupos de desarrolladores y espacios de discusión organizados |
| Slack | Colaboración de equipo, notificaciones de espacio de trabajo y flujos de canal |
| WeChat | Conversaciones personales para personas que utilizan WeChat diariamente |

LightVela también proporciona páginas de configuración para otros canales compatibles. La página de Canal en la consola es la fuente de verdad sobre lo que actualmente está disponible para su Hermes Agent.

### 2. Complete el flujo de conexión específico de la plataforma

Abra el área de Canal en la consola, seleccione la plataforma y siga su flujo de autorización o credenciales. Utilice la guía correspondiente en lugar de copiar credenciales de una plataforma no relacionada:

- [Telegram](../configuration/channel-telegram.md)
- [WhatsApp](../configuration/channel-whatsapp.md)
- [Discord](../configuration/channel-discord.md)
- [Slack](../configuration/channel-slack.md)
- [WeChat](../configuration/channel-wechat.md)

Trate los tokens de bot, IDs de aplicación y secretos como contraseñas. No peguéslos en un chat de grupo, documento público o mensaje dirigido a otra persona. Si una credencial se expone, rotéela en la plataforma que la emitió antes de reconectar Hermes.

![La página de conexión de canal de LightVela](../images/use-case-messaging-connection.png)

### 3. Verifique la conexión con una conversación simple

Después de que la consola muestre el canal como conectado, busque el bot o la conversación en esa plataforma y envíe un mensaje corto:

```text
Hi Hermes. Please reply with the channel you received this from.
```

Esto verifica la ruta completa: la plataforma puede entregar el mensaje, Hermes tiene un modelo funcional y la respuesta puede regresar al mismo lugar. Si no funciona, verifique primero el estado de conexión, luego confirme el modelo activo en [Configurar Modelos](../configuration/model.md).

### 4. Decida qué debe compartirse entre canales

Cuando más de un canal se conecta al mismo Hermes Agent, son diferentes puertas hacia el mismo asistente. Esto significa que el Agent puede mantener la misma memoria, preferencias de trabajo e Skills instaladas entre los canales compatibles.

Utilice [Gestión de Memoria](../configuration/memory.md) para revisar el contexto a largo plazo que desea que Hermes retenga. Si un canal es para una audiencia diferente o necesita un rol muy diferente, considere mantener el caso de uso separado en lugar de mezclar expectativas no relacionadas en un historial de conversación.

![El mismo contexto de Hermes Agent compartido entre canales](../images/use-case-messaging-memory.png)

Si Discord es el canal que desea utilizar para una comunidad, continúe con [Conozca a LightVela para Discord: Su Agent de IA Discord Bot que Sientra su Canal](./discord-community-agent.md).

## Preguntas frecuentes

### ¿Puedo conectar varias plataformas de mensajería a un solo Hermes Agent?

Sí. Los canales compatibles pueden apuntar al mismo Agent, lo que le permite acceder a él desde más de una aplicación de mensajería mientras se preserva el mismo comportamiento configurado y memoria.

### ¿Qué canal debo conectar primero?

Elija el uno que ya utilice con más frecuencia. Un asistente personal es más probable que sea útil cuando el primer mensaje es fácil de enviar. Telegram, WhatsApp, Discord, Slack y WeChat cada uno tienen guías de configuración detalladas.

### ¿Por qué el canal aparece como conectado pero Hermes no responde?

Envíe un mensaje de prueba simple, luego verifique que haya un modelo activo o créditos de prueba disponibles. Si el problema persiste, reconecte el canal y utilice [Diagnósticos](../configuration/diagnostics.md) para revisar opciones de mantenimiento y registros recientes.

### ¿Puedo compartir una credencial de bot entre múltiples Hermes Agents?

Evite hacerlo a menos que la plataforma y su flujo de trabajo previsto lo respalden claramente. Mantener una credencial unida a un propósito claro facilita mucho la resolución de problemas y el control de acceso.

## Próximos pasos

- [Configurar Modelos](../configuration/model.md) - confirme que Hermes tiene un modelo listo para responder.

- [Gestión de Memoria](../configuration/memory.md) - gestione el contexto compartido por sus canales conectados.

- [Tareas programadas](../configuration/automation.md) - entregue actualizaciones programadas a un canal conectado cuando corresponda.
