# Cómo usar un asistente de IA para comunidades en grupos de Telegram: preguntas y respuestas, resúmenes y recordatorios

## Resumen

**LightVela admite mensajes de grupos de Telegram cuando desactiva Group Privacy para el bot en BotFather, añade el bot al grupo e inicia la conversación mencionándolo con `@bot_username`.**
Esta guía explica esa configuración verificada y muestra cómo usar el mismo Hermes Agent para preguntas y respuestas, resúmenes y recordatorios en grupos, sin presentar los eventos de incorporación de miembros ni las respuestas pasivas no verificadas como funciones configuradas.

![Un asistente de IA para comunidades en grupos de Telegram para preguntas y respuestas, resúmenes y recordatorios](../images/use-case-08-telegram-group-community-assistant.png)

## Antes de empezar

Necesita un bot de Telegram conectado a su Hermes Agent mediante [Configurar canal - Telegram](../configuration/channel-telegram.md).
También necesita permiso para añadir ese bot al grupo de Telegram en el que quiere utilizarlo.

## Habilitar los mensajes de grupo de Telegram

### 1. Abrir BotFather y seleccionar el bot

1. Abra `@BotFather` en Telegram.
2. Envíe `/mybots`.
3. Seleccione el bot conectado a su Hermes Agent.

### 2. Desactivar Group Privacy

1. Abra "Bot Settings".
2. Seleccione "Group Privacy".
3. Elija "Turn off" o "Disable privacy mode".

Esta configuración permite que el bot reciba los mensajes de grupo que lo mencionen.

### 3. Añadir el bot a un grupo de Telegram

1. Abra el grupo de Telegram en el que quiere utilizarlo.
2. Seleccione "Add Members" o la acción equivalente para gestionar integrantes.
3. Busque el bot por su nombre de usuario y añádalo al grupo.

### 4. Mencionar al bot para probar los mensajes de grupo

Envíe un mensaje que mencione al bot, por ejemplo: `@bot_username resume la conversación hasta ahora`.

El resultado esperado es una respuesta de Hermes Agent en ese mismo grupo.

## Alcance verificado de los mensajes

| Interacción | Alcance documentado actual | Cómo validarlo |
|---|---|---|
| Conversación de grupo | Compatible cuando el bot se ha añadido al grupo, Group Privacy está desactivado y el mensaje menciona al bot | Envíe `@bot_username hola` en el grupo y confirme que la respuesta aparece allí |
| Conversación directa | Compatible mediante el bot de Telegram conectado | Envíe un mensaje en el chat directo del bot y confirme que responde |
| Bienvenida automática al incorporarse un miembro o respuestas pasivas | Esta guía de configuración no establece estas funciones | Valide estos comportamientos por separado antes de incorporarlos a un flujo de operación |

## Usar el bot como asistente de comunidad

Después de que la prueba de grupo funcione, defina un rol y unos límites de información claros con la [guía de personalidad de SOUL.md](./im-agent-persona-soul-md.md).
Use instrucciones explícitas en el grupo para que los participantes sepan cuándo se solicita una respuesta al Agent.

| Flujo de trabajo | Ejemplo de instrucción en el grupo | Resultado que debe comprobar |
|---|---|---|
| Preguntas frecuentes | `@bot_username responde solo con la información de las preguntas frecuentes preparadas` | La respuesta utiliza el material preparado o solicita claramente la intervención de una persona |
| Resumen de la conversación | `@bot_username resume las decisiones, tareas, responsables y preguntas pendientes` | La respuesta separa las decisiones confirmadas de los asuntos sin resolver |
| Borrador de recordatorio | `@bot_username redacta un recordatorio con hora, audiencia, propósito y método de cancelación` | Revise el borrador antes de utilizar cualquier automatización para enviarlo |

Para recuperación de información, resúmenes o contenido programado, elija una Skill de confianza y revise sus permisos en [Configurar Skills](../configuration/skill.md).
Valide una automatización por separado en un canal de destino compatible antes de depender de ella para mensajes programados.

## Límites de seguridad y operación

Desactivar Group Privacy habilita la entrega de mensajes de Telegram.
No sustituye la responsabilidad de establecer reglas para el grupo, evitar compartir información sensible y exigir confirmación antes de ejecutar acciones externas de alto riesgo.
Consulte la [guía de límites de seguridad de Telegram y WhatsApp](./telegram-whatsapp-safety-boundaries.md) al definir quién puede pedir al Agent que realice acciones sensibles.

## Preguntas frecuentes

### ¿Puedo añadir ahora un bot de Telegram de LightVela a un grupo?

Sí.
Desactive Group Privacy en BotFather, añada el bot al grupo y menciónelo con `@bot_username` para iniciar una conversación.

### ¿Desactivar Group Privacy hará que el bot responda en un grupo?

Es una parte necesaria de la configuración documentada.
Después de desactivarlo, añada el bot al grupo y menciónelo en un mensaje de prueba.

### ¿Esta guía configura mensajes de bienvenida automáticos para nuevos miembros?

No.
Esta guía documenta conversaciones de grupo iniciadas al mencionar al bot.
Valide por separado los eventos de incorporación de miembros y cualquier flujo de bienvenida automático antes de prometerlos a una comunidad.

### ¿Se pueden utilizar los grupos de WhatsApp como alternativa?

La documentación actual del canal de WhatsApp sigue indicando que los chats de grupo no son compatibles.
No presuponga que la compatibilidad con mensajes de grupo de Telegram se extiende a WhatsApp.

## Próximos pasos

- [Configurar canal - Telegram](../configuration/channel-telegram.md) - Conecte el bot y repita los pasos de configuración de mensajes de grupo.

- [Cómo convertir un Agent de IM en un asistente de atención al cliente, comunidad o compañía con Skills](./im-agent-skill-scenarios.md) - Prepare Skills y contenido para preguntas y respuestas y resúmenes en grupos.

- [Cómo definir el rol, la personalidad y la voz de un Agent de IM con SOUL.md](./im-agent-persona-soul-md.md) - Defina el rol y los límites del asistente.
