# Cómo conectar un solo Agent a Telegram y WhatsApp manteniendo una sola personalidad y memoria a largo plazo

## Resumen

**Telegram y WhatsApp pueden servir como dos puntos de entrada al mismo Hermes Agent. Mientras que ambos canales se conecten al mismo Agent, comparten la personalidad del Agent, las Skills, las tareas programadas y la memoria a largo plazo, sin necesidad de duplicar la configuración por plataforma.** Sin embargo, "unificado" tiene un alcance definido: lo que se comparte son los activos del nivel del Agent, mientras que cada canal mantiene su propio flujo de autorización y límites de mensajes, por lo que conectarlos son dos pasos de autorización independientes. La forma más directa de verificar el compartir es decir algo en un canal y preguntar sobre ello en el otro — una respuesta correcta prueba que ambos puntos de entrada se resuelven al mismo Agent. Después de conectar, también confirme que las respuestas lleguen en la conversación desde la que se envió el mensaje, y no en otra.

![Un Agent conectado a Telegram y WhatsApp con una sola personalidad y memoria a largo plazo](../images/use-case-07-multi-channel-personality-memory.png)

## Para quién es esto

Esta guía es para personas que desean cambiar entre aplicaciones de mensajería manteniendo una sola identidad de asistente de IA.

Es útil cuando se mueve entre Telegram y WhatsApp, o cuando se desea gestionar un asistente personal, socio de investigación o asistente de redacción de soporte desde un solo lugar.

## Entender qué significa "un Agent"

Un Agent no significa que los dos canales compartan cada parte del guion de chat en tiempo real.

Los dos puntos de entrada comparten la configuración del nivel del Agent y el contexto duradero, mientras que cada conversación actual pertenece a su propia sesión de canal.

Si desea que el otro canal conozca un hecho confirmado, pida a Hermes que lo recuerde y luego verifíquelo desde el otro punto de entrada.

La personalidad, la memoria a largo plazo y las Skills pertenecen a la capa del Agent, mientras que los tokens del Bot, la autorización QR, los puntos de entrada de conversación y los formatos de mensaje pertenecen a la capa del canal.

## Requisitos previos

- Un Hermes Agent LightVela en ejecución.
  Si aún no ha creado uno, comience con [Quickstart](../02-quickstart.md).

- Una configuración de modelo funcional o créditos de prueba disponibles.

- Una cuenta de Telegram y un Bot que pueda usar normalmente.

- Una cuenta de WhatsApp que pueda usar normalmente.

- Conocer la configuración de mensajes de grupo de Telegram: desactive Group Privacy en BotFather, añada el bot al grupo e inicie la conversación con `@bot_username`.

- Entender que la compatibilidad con grupos de WhatsApp sigue sujeta a la documentación de ese canal.

## Pasos

### 1. Elija un Agent objetivo

Abra la consola de LightVela y decida qué único Hermes Agent debe recibir las conexiones de Telegram y WhatsApp.

No cree un Agent por canal a menos que intencionalmente desee personalidades, memorias y Skills diferentes.

### 2. Conectar Telegram

Siga [Configure Channel - Telegram](../configuration/channel-telegram.md) para crear un Bot y pegue el token de la API HTTP en la configuración del canal objetivo del Agent.

Envíe un mensaje de prueba en Telegram, confirme que la consola muestre el canal como conectado y confirme que la respuesta regrese al Bot esperado.

Si también desea una personalidad de Telegram distinta, vea [Cómo configurar un Hermes Agent con una personalidad distinta en Telegram](./telegram-persona-agent.md).

### 3. Conectar WhatsApp

En la configuración del canal del mismo Hermes Agent, seleccione WhatsApp y complete la autorización QR siguiendo [Configure Channel - WhatsApp](../configuration/channel-whatsapp.md).

Abra el contacto del bot correspondiente en WhatsApp, envíe un mensaje de prueba y confirme que la respuesta regrese normalmente.

Si también desea una personalidad de WhatsApp distinta, vea [Cómo configurar un Hermes Agent con una personalidad distinta en WhatsApp](./whatsapp-persona-agent.md).

### 4. Configurar una personalidad del nivel del Agent

Abra la sección "Personalidad" del Agent objetivo y confirme que el rol, la voz, las prioridades y los límites de comportamiento en SOUL.md funcionen para ambos canales.

Dado que la personalidad está en la capa del Agent, no necesita configurar dos copias en Telegram y WhatsApp.

Si necesita cambiar la personalidad, vea [Cómo definir el Rol, Personalidad y Voz de un Agent IM con SOUL.md](./im-agent-persona-soul-md.md).

Después de un cambio, inicie una nueva conversación en cada canal y ejecute una autocomprobación rápida para confirmar que la nueva personalidad esté activa.

### 5. Configurar la memoria del Agent y el perfil de usuario

Abra "Memoria" en la consola y confirme que la memoria del Agent y la capacidad del perfil de usuario se ajusten a su flujo de trabajo.

Telegram y WhatsApp comparten la misma memoria a largo plazo del Agent en la nube, por lo que no necesita ingresar la misma identidad, idioma y preferencias dos veces.

En cualquiera de los canales, puede enviar:

    Recuerda que quiero que cada informe diario comience con la conclusión y luego dé tres puntos clave de evidencia.

Luego cambie al otro canal y envíe:

    Use el formato de informe diario que establecí anteriormente y muéstrame un ejemplo breve.

Si los canales se comportan de manera diferente, primero confirme que se conectan al mismo Agent, luego verifique si la conversación actual necesita /new.

### 6. Instalar Skills compartidas una vez

Las Skills pertenecen a la configuración de capacidad del Agent, por lo que no necesita una instalación para Telegram y otra para WhatsApp.

Pida a Hermes que instale la Skill a través de la conversación en cualquiera de los canales, luego pídaale que actualice la lista de Skills y valide la Skill con una tarea de bajo riesgo.

Vea [Configurar Skills](../configuration/skill.md) para el flujo detallado, y revise la fuente de la Skill, los permisos y las dependencias de servicios externos antes de confirmar la instalación.

### 7. Probar diferencias específicas del canal

Ejecute los mismos prompts en ambos canales:

    Explique tu rol actual y cómo manejas la incertidumbre.

    Usa mis preferencias guardadas para convertir este contenido en tres puntos clave.

Luego pruebe comportamientos que pertenecen al canal, como mensajes multimedia, recordatorios proactivos o cómo aparece el contacto del Bot.

La personalidad y la memoria a largo plazo deben permanecer consistentes, pero el formato de mensaje, la capacidad multimedia, la autorización y los límites de entrega proactiva pueden diferir.

## Una estructura útil para un Agent y dos puntos de entrada

    Un Hermes Agent
    ├── un SOUL.md
    ├── una memoria del Agent y perfil de usuario
    ├── un conjunto de Skills instaladas
    ├── un conjunto de tareas programadas
    ├── punto de entrada de Telegram
    └── punto de entrada de WhatsApp

Los métodos de notificación de tarea programada aún necesitan un canal objetivo explícito.

No asuma que un Agent compartido causa que cada recordatorio se envíe tanto a Telegram como a WhatsApp.

## Preguntas frecuentes

### ¿Algo que le pidí a Hermes que recuerde en Telegram aparecerá en WhatsApp?

Sí, cuando ambos canales se conectan al mismo Hermes Agent y la información se guarda en la memoria del Agent o en el perfil de usuario.

Cada mensaje en la conversación actual de Telegram no se convierte automáticamente en un guion de WhatsApp en vivo.

### ¿Por qué los dos canales no suenan exactamente igual?

Los formatos de mensaje del canal, las capacidades multimedia, el estado de sesión y la salida del modelo pueden afectar los detalles.

Primero confirme que ambos canales se conectan al mismo Agent, luego envíe /new cuando sea necesario para que el nuevo SOUL.md cargue al inicio de la conversación.

### ¿Puedo configurar personalidades diferentes para Telegram y WhatsApp?

Cuando ambos canales se conectan a un Agent, utilizan por defecto la misma personalidad del nivel del Agent.

Si necesita roles y memorias completamente diferentes, cree Agents diferentes y conecte los canales por separado.

### ¿Pueden los grupos de WhatsApp compartir memoria con Telegram?

La documentación actual de WhatsApp indica que los chats de grupo no son compatibles.
Telegram admite mensajes de grupo después de desactivar Group Privacy, añadir el bot al grupo e iniciar la conversación con `@bot_username`.

El uso multicanal mantiene la capa del Agent consistente, pero no modifica las condiciones de configuración ni los límites propios de cada canal.

### ¿Una tarea programada enviará a ambos canales automáticamente?

No.

Cuando cree o edite una tarea programada, confirme su método de notificación y canal objetivo, luego pruebe el resultado de la entrega por separado.

## Próximos pasos

- [Cómo Hermes Agent Conecta Múltiples Canales de Mensajería](../hermes-agent/07-message-gateway.md) - Entienda la relación entre canales, pasarela y capa del Agent.

- [Gestión de Memoria](../configuration/memory.md) - Revise la gestión de memoria del Agent y perfil de usuario.

- [Configurar Canal - Telegram](../configuration/channel-telegram.md) - Complete la configuración del Bot de Telegram.

- [Configurar Canal - WhatsApp](../configuration/channel-whatsapp.md) - Complete la autorización de WhatsApp.

- [Cómo convertir un Agent IM en un Asistente de Servicio al Cliente, Comunidad o Acompañante con Skills](./im-agent-skill-scenarios.md) - Extienda una personalidad consistente con flujos de trabajo prácticos.
