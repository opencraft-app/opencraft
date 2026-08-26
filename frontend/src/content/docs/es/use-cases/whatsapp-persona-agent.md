# Cómo configurar un Agent Hermes con una personalidad distinta en WhatsApp

## Resumen

**WhatsApp lleva los mensajes; el rol, tono, límites y contexto a largo plazo del Agent provienen de su configuración en LightVela — cambiar el punto de entrada no cambia quién es.** Conecte primero el canal de WhatsApp (autorice según la guía del canal y confirme que la consola lo muestra como conectado), luego utilice la sección de Personalidad en la página de configuración del Agent para seleccionar e inyectar una personalidad adecuada para mensajes personales, recordatorios o conversaciones con clientes. Si este Agent se enfrenta a clientes o un equipo, nombre explícitamente al público objetivo en la personalidad y agregue el tono de marca, el alcance que puede manejar y las condiciones para escalar a un humano. Después de conectar, envíe un mensaje de prueba y confirme que la respuesta llegue a la conversación esperada. Si nada llega, verifique si el modelo está configurado, si los créditos de prueba se han agotado y si el canal se muestra como conectado.

![Un Agent Hermes con una personalidad distinta en WhatsApp](../images/use-case-04-whatsapp-persona-agent.png)

## Para quién es este documento

Esta guía es para personas que desean un Agent Hermes con una voz consistente y un contexto de trabajo útil en WhatsApp.
Funciona especialmente bien para asistencia personal, recordatorios diarios, organización de información y otros escenarios 1 a 1 donde el estilo de conversación debe mantenerse predecible.

WhatsApp está actualmente destinado principalmente para conversaciones 1 a 1.
Si aún no ha conectado WhatsApp, comience con [Configurar Canal - WhatsApp](../configuration/channel-whatsapp.md).

## Requisitos previos

- Un Agent Hermes Hermes en ejecución.
  Si aún no ha creado uno, comience con el [Inicio rápido](../02-quickstart.md).

- Una configuración de modelo funcional o créditos de prueba disponibles.
  Si Hermes aún no puede responder, complete [Configurar Modelos](../configuration/model.md).

- Una cuenta de WhatsApp que pueda recibir mensajes de verificación, con autorización completada mediante [Configurar Canal - WhatsApp](../configuration/channel-whatsapp.md).

- Un breve resumen de personalidad.
  Decida quién sirve el Agent, qué problema ayuda, cómo debe sonar y qué acciones siempre requieren su confirmación.

## Pasos / conceptos clave

### 1. Conecte primero el canal de WhatsApp

Abra el Agent Hermes objetivo en la consola de LightVela, vaya a "Canales" y seleccione WhatsApp.
Siga [Configurar Canal - WhatsApp](../configuration/channel-whatsapp.md) a través de la autorización del teléfono, el código de verificación o el flujo de QR, luego envíe un mensaje de prueba.

Confirme que WhatsApp aparece como conectado en la consola y que el Agent Hermes responde en WhatsApp.
Si el canal no está conectado aún, resuelva problemas de autorización, modelo o créditos antes de afinar la personalidad.

### 2. Redacte un breve de rol para el contexto de WhatsApp

Las conversaciones de WhatsApp suelen ser más cortas e inmediatas, y pueden mezclar solicitudes personales y laborales en el mismo hilo.
Junto con describir quién es el Agent, defina la longitud de sus respuestas, el comportamiento de aclaración y los límites alrededor de acciones de alto riesgo.

Comience con un breve de rol como este:

```text
You are my everyday WhatsApp assistant.
Help me organize to-dos, follow-ups, and short messages, but do not take external actions without my confirmation.
Use a concise, natural, friendly tone by default. Use short sections when an explanation is needed instead of sending one long block.
If my request is missing a time, person, or goal, ask the single most important clarifying question first.
```

Si el Agent de WhatsApp sirve a clientes o un equipo, reemplace "mi" con el público objetivo previsto y agregue la voz de marca, el alcance respaldado y las condiciones para pasar una solicitud a un humano.

### 3. Elija e inyecte un Alma desde la Personalidad

Abra la configuración del Agent objetivo y seleccione la sección de "Personalidad".
Puede elegir una Alma al azar o usar la prueba de personalidad para encontrar una coincidencia más cercana.

Revise la descripción de rol, voz y comportamiento en la tarjeta, seleccione la misma y haga clic en "Inyectar alma".
LightVela escribe la Alma seleccionada en el `SOUL.md` actual del Agent Hermes y mantiene una copia de seguridad antes de reemplazar la personalidad anterior.

Solo una Alma está activa para un Agent a la vez.
Si inyecta una nueva, las respuestas de WhatsApp usarán la nueva personalidad en una nueva conversación, así que compare los roles antiguos y nuevos antes de confirmar.

### 4. Inicie una nueva conversación en WhatsApp

Después de inyectar la Alma, envíe este mensaje en la conversación de WhatsApp:

```text
/new
```

Esto permite que el Agent Hermes lea el nuevo `SOUL.md` cuando comienza la nueva conversación.
Si la conversación antigua aún suena igual, confirme que se envió `/new` con éxito antes de continuar la prueba.

Use una autocomprobación breve para verificar el resultado:

```text
Explain who you serve, your default reply style, and what you do when a request would send a message outside this chat.
```

### 5. Calibre el ritmo de WhatsApp con mensajes reales

En WhatsApp, una personalidad útil no se trata solo de sonar como un personaje en particular.
También incluye la longitud del mensaje, el agrupamiento y cuándo preguntar una pregunta de seguimiento.

Pruébelo con tres tipos de mensajes:

```text
Turn this content into three messages I could send to a colleague.
```

```text
Remind me to follow up on this tomorrow at 3 PM, and first tell me what information you plan to record.
```

```text
This request might trigger an external action. List the risks and what you need me to confirm first.
```

Si las respuestas son demasiado largas, guarde una preferencia como "mantener la respuesta por defecto en tres secciones cortas".
Si el Agent necesita contexto de proyecto estable, use las capacidades de [Gestión de Memoria](../configuration/memory.md) para preservar los hechos que deben permanecer útiles.

## Mantenga la personalidad separada de los flujos de servicio al cliente

La personalidad define el rol y la voz que usa el Agent.
Las Skills definen si puede realizar una tarea particular.
Las automatizaciones definen cuándo inicia el trabajo proactivamente.
La memoria y el perfil de usuario definen qué contexto a largo plazo debe retener.

Por ejemplo, una personalidad cálida de servicio al cliente no proporciona automáticamente búsqueda de pedidos, búsqueda en base de conocimientos o capacidades de reembolso.
Esas capacidades necesitan configuración de modelo, Skills, archivos de referencia y límites de acción explícitos.

Para una explicación más profunda del límite entre personalidad, preferencias de usuario y memoria a largo plazo, lea [De dónde proviene la personalidad del Agent Hermes](../hermes-agent/10-persona-user-memory.md).

## Preguntas frecuentes

### ¿Debería un número de WhatsApp mapearse a un Agent Hermes?

En general, un número de WhatsApp debería estar vinculado a un Agent Hermes.
Si necesita varios roles distintos, use números de WhatsApp separados e instancias de Agent Hermes en lugar de reemplazar repetidamente una personalidad en el mismo hilo.

### ¿Inyectar una nueva Alma elimina el historial de WhatsApp o la memoria?

No.
Inyectar una nueva Alma reemplaza principalmente el `SOUL.md` actual del Agent, mientras que `/new` inicia una conversación fresca.
La memoria a largo plazo y el perfil de usuario permanecen como capas de contexto separadas, aunque la nueva personalidad puede cambiar cómo Hermes interpreta y utiliza ese contexto.

### ¿Puedo usar esta configuración en un grupo de WhatsApp?

La documentación actual de WhatsApp define las conversaciones 1 a 1 como el alcance soportado, por lo que los grupos no forman parte de esta guía.
Consulte [Configurar Canal - WhatsApp](../configuration/channel-whatsapp.md) para las limitaciones actuales del canal.

### ¿Puede un Agent de WhatsApp enviar mensajes proactivamente?

Los mensajes proactivos también están sujetos a las reglas de plantilla de mensaje y ventana de conversación de WhatsApp.
Si desea recordatorios programados, lea [Automatizaciones](../configuration/automation.md) y confirme que el método de entrega se ajusta a los límites reales del canal de WhatsApp.

## Próximos pasos

- [Cómo configurar un Agent Hermes con una personalidad distinta en Telegram](./telegram-persona-agent.md) - Compare la configuración con otro canal de mensajería internacional.

- [Cómo definir el rol, personalidad y voz de un Agent IM con SOUL.md](./im-agent-persona-soul-md.md) - Mantenga personalidad, perfil de usuario, memoria y Skills separadas.

- [Configurar Canal - WhatsApp](../configuration/channel-whatsapp.md) - Siga el flujo completo de autorización y solución de problemas de WhatsApp.

- [Automatizaciones](../configuration/automation.md) - Programar recordatorios o revisiones que ya se han probado en conversación.
