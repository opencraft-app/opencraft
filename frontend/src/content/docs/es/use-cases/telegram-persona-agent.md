# Cómo configurar un Hermes Agent con una personalidad distintiva en Telegram

## Resumen

**Telegram es solo un punto de entrada. Lo que determina cómo habla el Agent, cómo funciona y qué no hará es su personalidad y contexto a largo plazo.** El flujo tiene dos mitades: primero, conecte el Hermes Agent a Telegram siguiendo la guía del canal (cree un bot con BotFather para obtener un token, conéctelo en la consola y confirme que aparece como conectado), luego utilice la sección de Personalidad en la página de configuración del Agent para seleccionar un rol estable, tono y un conjunto de límites e inyectarlo. Mantenga las tres capas distintas: la personalidad contiene principios de comportamiento duraderos, el perfil de usuario contiene cómo desea ser tratado y la memoria a largo plazo contiene hechos confirmados y antecedentes del proyecto. Tenga en cuenta que el canal de Telegram actualmente solo soporta conversaciones uno a uno, no chats grupales.

![Un Hermes Agent con una personalidad distintiva en Telegram](../images/use-case-03-telegram-persona-agent.png)

## Para quién es este documento

Esta guía es para personas que desean un Hermes Agent con una personalidad consistente en Telegram a lo largo del tiempo.
Funciona bien como asistente personal, socio de investigación, compañero de estudios o cualquier asistente cotidiano que deba comunicarse de manera predecible.

Telegram está actualmente destinado principalmente para conversaciones uno a uno.
Si necesita conectar Telegram, comience con [Configurar Canal - Telegram](../configuration/channel-telegram.md).

## Requisitos previos

- Un Hermes Agent LightVela en ejecución.
  Si aún no ha creado uno, comience con [Quickstart](../02-quickstart.md).

- Una configuración de modelo funcional o créditos de prueba disponibles.
  Si Hermes aún no puede responder, complete [Configurar Modelos](../configuration/model.md).

- Una cuenta de Telegram y un Bot conectado siguiendo [Configurar Canal - Telegram](../configuration/channel-telegram.md).

- Una primera idea del rol que desea que el Agent desempeñe.
  Podría ser un asistente de investigación conciso, un paciente socio de estudios o un asistente de recordatorios enfocado en la ejecución.

## Pasos / conceptos clave

### 1. Conectar Hermes Agent a Telegram

Abra el Hermes Agent objetivo en la consola de LightVela, vaya a "Canales" y seleccione Telegram.
Siga [Configurar Canal - Telegram](../configuration/channel-telegram.md) para crear un Bot, pegue el token de la API HTTP y envíe un mensaje de prueba.

Confirme que Telegram aparece como conectado en la consola y que el Bot recibe una respuesta de Hermes Agent.
Verifique el canal primero para que los problemas posteriores sean más fáciles de distinguir de los problemas de configuración de personalidad.

### 2. Describa cómo desea que el Agent funcione

Una personalidad distintiva es más que un nombre o un refrán.
Antes de configurarla, escriba el rol, voz, estilo de trabajo y límites que desea mantener estables.

Utilice un breve corto como este como punto de partida:

```text
You are my research assistant. Help me break down questions, compare reliable sources, and write clear conclusions.
Give the conclusion first, then the key evidence. State uncertainty instead of presenting guesses as facts.
Use a professional, direct, friendly tone. Do not be performatively cute, and do not invent certainty.
Ask for confirmation before sending messages, changing files, or taking other external actions.
```

Este breve le ayuda a elegir una Soul adecuada y le proporciona el lenguaje para refinar el comportamiento del Agent después de que Telegram esté conectado.

### 3. Elija e inyecte una Soul desde Personalidad

Abra la configuración del Agent objetivo y seleccione la sección "Personalidad".
Puede elegir "Dibujar alma al azar" o "Prueba de personalidad de Soul", luego revise la descripción en cada tarjeta.

Seleccione la Soul que mejor se ajuste al rol y haga clic en "Inyectar alma".
LightVela escribe la personalidad seleccionada en el `SOUL.md` actual del Hermes Agent y mantiene una copia de seguridad antes de reemplazar una configuración existente.

Si el Agent ya tiene otra Soul, la inyección de una nueva reemplaza la personalidad actualmente activa.
Revise el rol, voz y límites de la tarjeta antes de confirmar el reemplazo.

### 4. Inicie una nueva conversación en Telegram

Después de inyectar la Soul, vuelva al chat de Telegram y envíe:

```text
/new
```

Hermes Agent lee el nuevo `SOUL.md` cuando inicia una nueva conversación.
Si continúa una conversación antigua sin enviar `/new`, esa conversación podría seguir utilizando la captura de personalidad anterior.

Una vez que inicie la nueva conversación, pida una autocomprobación rápida:

```text
In three sentences, explain your current role, what you can help me with, and what you will not do for me.
```

### 5. Calibre la voz con tareas reales

No juzgue la personalidad solo preguntando "¿Quién eres?".
Utilice varias tareas que realmente enviaría en la vida diaria, como:

```text
Turn this research material into conclusions, evidence, and questions that still need confirmation.
```

```text
I have three deadlines today. Rank them by risk, then give me a concise plan.
```

```text
This request would send content to an external service. What would you do first?
```

Verifique si el Agent mantiene la voz esperada, marca la incertidumbre y respeta el límite alrededor de las acciones externas.
Si algo es una preferencia específica del usuario, como su idioma, zona horaria o formato de briefing, pida a Hermes que lo recuerde en lugar de convertir cada preferencia en reglas de personalidad.

## Cómo encajan personalidad, preferencias de usuario y memoria

`SOUL.md` es lo mejor para el rol estable, voz, prioridades y límites de comportamiento del Agent.
El perfil de usuario es lo mejor para su identidad, idioma, zona horaria y preferencias de comunicación.
La memoria a largo plazo es lo mejor para hechos establecidos, estado del proyecto y contexto reutilizable de su trabajo compartido.

Para una explicación más profunda, lea [De dónde proviene la personalidad del Hermes Agent](../hermes-agent/10-persona-user-memory.md) y [Gestión de memoria](../configuration/memory.md).

## Preguntas frecuentes

### ¿El Bot de Telegram tiene su propia personalidad?

La personalidad pertenece al Hermes Agent conectado a Telegram, no al token de BotFather.
Si el mismo Hermes Agent está conectado a otros canales compatibles, esos canales utilizan la misma personalidad de nivel de Agent y contexto duradero.

### ¿Elimina `/new` la memoria?

No.
`/new` inicia una conversación fresca para que se cargue el nuevo `SOUL.md` al inicio de la sesión.
No elimina la memoria a largo plazo del Agent ni el perfil de usuario.

### ¿Puedo agregar el Bot de Telegram a un grupo?

La documentación actual de Telegram trata las conversaciones uno a uno como el modo principal soportado, y el comportamiento del grupo también está afectado por la configuración del canal y la configuración de privacidad.
No utilice esta guía como configuración de chat de grupo; consulte [Configurar Canal - Telegram](../configuration/channel-telegram.md) para el alcance actual de soporte.

### ¿Hacer cambiar el modelo hará que el Agent pierda su personalidad?

Normalmente no.
El modelo, la personalidad del Agent y la memoria a largo plazo son capas de configuración separadas, aunque cambiar el modelo puede cambiar el razonamiento, el uso de herramientas y pequeños detalles del estilo de respuesta.

## Próximos pasos

- [Cómo configurar un Hermes Agent con una personalidad distintiva en WhatsApp](./whatsapp-persona-agent.md) - Aplique la misma personalidad de Agent a conversaciones WhatsApp uno a uno.

- [Cómo definir el rol, personalidad y voz de un IM Agent con SOUL.md](./im-agent-persona-soul-md.md) - Comprenda la frontera entre Soul, personalidad y memoria a largo plazo.

- [Configurar Canal - Telegram](../configuration/channel-telegram.md) - Siga el flujo completo de conexión del Bot de Telegram.

- [Configurar Skills](../configuration/skill.md) - Extienda una personalidad estable con capacidades prácticas de tareas.
