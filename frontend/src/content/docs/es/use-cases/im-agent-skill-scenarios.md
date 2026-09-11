# Cómo convertir un Agent de IM en un asistente de servicio al cliente, comunidad o compañero con Skills

## Resumen

**Convertir un solo Agent de IM en un Agent de soporte, asistente de comunidad o compañero de IA se reduce a la división entre Skills y personalidad: las Skills extienden lo que puede hacer, mientras que `SOUL.md` define quién es y dentro de qué límites actúa.** Ambos son necesarios — las Skills sin una personalidad producen respuestas inconsistentes, y una personalidad sin Skills carece de métodos reutilizables. En LightVela, las Skills provienen de los mercados públicos Skills.sh y ClawHub; hoy, las instalas o eliminas diciéndoselo a Hermes en la conversación (la instalación por consola-pannel llegará pronto), y luego verificas la disponibilidad en el chat. Los tres escenarios difieren principalmente en el diseño de límites: el soporte necesita condiciones de escalación explícitas, los asistentes de comunidad necesitan saber cuándo mantenerse en silencio, y el uso de compañeros necesita temas claros fuera de límites. Trabaja a través de la lista de verificación de seguridad antes de ponerlo en producción.

![Conversión de un Agent de IM en un asistente de servicio al cliente, comunidad o compañero con Skills](../images/use-case-06-im-agent-skill-scenarios.png)

## Para quién es este documento

Esta guía es para personas que han conectado Telegram, WhatsApp u otro canal de mensajería y desean usar un Agent para un flujo de trabajo concreto.

Es especialmente útil para líderes de soporte, operadores de comunidad e individuos que desean un compañero de IA que pueda trabajar con ellos a lo largo del tiempo.

## Requisitos previos

- Un Agent Hermes LightVela en funcionamiento.
  Si aún no has creado uno, comienza con [Quickstart](../02-quickstart.md).

- Un canal de mensajería que ya pueda manejar una conversación normal.
  Puedes comenzar con [Cómo configurar un Agent Hermes con una personalidad distinta en Telegram](./telegram-persona-agent.md) o [Cómo configurar un Agent Hermes con una personalidad distinta en WhatsApp](./whatsapp-persona-agent.md).

- Una primera definición del flujo de trabajo objetivo, acciones permitidas y situaciones que requieren intervención humana.

- Una Skill de confianza seleccionada de [Skills.sh](https://skills.sh/) o [ClawHub](https://clawhub.ai/).

## Comprender el límite entre Skills y personalidad

Una Skill es un paquete de capacidades callable, como navegación web, organización de contenido, resúmenes diarios o un flujo de trabajo especializado.

SOUL.md es mejor para describir quién es el Agent, cómo habla, cómo toma decisiones y qué acciones requieren confirmación.

El perfil de usuario y la memoria a largo plazo son para tu identidad, preferencias, hechos confirmados y contexto en curso.

No pongas guiones de cliente, reglas de grupo y permisos de alto riesgo en una descripción de personalidad indiferenciada.

## Pasos

### 1. Define el escenario principal del Agent

Diferentes escenarios necesitan diferentes combinaciones de Skills y límites de seguridad.

| Escenario | Objetivo principal | Dirección de Skill | Límite a definir primero |
|---|---|---|---|
| Servicio al cliente | Responder preguntas comunes y derivar solicitudes complejas | Recuperación de conocimiento, organización de tickets, búsqueda de pedidos | Escalar la incertidumbre y nunca prometer reembolsos o cambios de pedidos sin autorización |
| Asistente de comunidad | Dar la bienvenida a miembros, responder preguntas frecuentes, resumir discusiones | Recuperación de contenido, resúmenes, recordatorios programados | Evitar spam, proteger información de miembros y no tomar decisiones de moderación para administradores |
| Compañero de IA | Ofrecer compañía consistente, recordatorios y colaboración a largo plazo | Organización de memoria, programación, generación de contenido | Respetar rechazos y privacidad, evitar comportamientos de construcción de dependencia y declarar incertidumbre |

Comienza con un escenario primario en lugar de instalar muchas Skills de una vez.

### 2. Prepara material de referencia y un breve de personalidad

Para servicio al cliente, prepara preguntas frecuentes del producto, horarios de servicio, rutas de escalación y datos de contacto humano.

Para operaciones de comunidad, prepara un mensaje de bienvenida, preguntas frecuentes, reglas de la comunidad y un formato de resumen.

Para un compañero de IA, escribe el nombre preferido, voz, nivel de iniciativa y temas que deben permanecer fuera del alcance.

Coloca el material de referencia que Hermes necesita consultar en [Almacenamiento en la Nube](../configuration/files.md), y pon reglas de personalidad estables en SOUL.md a través de [Personalidad y SOUL.md](./im-agent-persona-soul-md.md).

### 3. Elige e instala una Skill

LightVela actualmente soporta pedirle a Hermes que instale una Skill de Skills.sh o ClawHub a través de la conversación.

Envía una solicitud como esta en un canal conectado:

    Por favor instala una Skill adecuada para organizar preguntas frecuentes de servicio al cliente de Skills.sh o ClawHub, y primero explica qué permisos necesita.

Si ya conoces el nombre de la Skill, sé explícito:

    Por favor instala [Nombre de la Skill]. Primero dime qué leerá, qué servicios externos llamará y si puede enviar mensajes proactivos.

La entrada visual de instalación de Skills en la consola aún está sujeta al estado de la página actual, así que consulta [Configurar Skills](../configuration/skill.md) para el flujo de instalación soportado.

Las Skills de alto riesgo pueden solicitar confirmación secundaria antes de la instalación.

Antes de confirmar, revisa la fuente de la Skill, permisos, llamadas a APIs externas y comportamiento proactivo.

### 4. Valida la Skill para su escenario

Prueba la nueva Skill en una conversación 1 a 1 antes de exponerla a una audiencia grande.

Para servicio al cliente, comienza con:

    Responde esta pregunta usando la FAQ preparada. Si el material no contiene una respuesta, dilo claramente y sugiere una intervención humana.

Para un asistente de comunidad, comienza con:

    Resume esta discusión en no más de cinco puntos y lista las preguntas que aún no tienen conclusión.

Para un compañero de IA, comienza con:

    Usa mi voz configurada para darme un breve chequeo de hoy, y explica qué detalles se retendrían como memoria a largo plazo.

Verifica si el Agent llamó a la Skill esperada, usó el material de referencia correcto y se detuvo para explicar limitaciones cuando estaba incierto.

### 5. Usa tareas programadas para trabajos repetitivos

Los mensajes de bienvenida, preguntas frecuentes, resúmenes y recordatorios pueden usar diferentes disparadores.

Usa [Tareas programadas](../configuration/automation.md) para trabajos que deben ejecutarse en un tiempo fijo, como enviar un resumen diario de la comunidad o recordar a un equipo de soporte sobre casos sin resolver.

Confirma el método de notificación y canal objetivo para cada tarea programada en lugar de asumir que cada canal puede recibir el mismo tipo de mensaje proactivo.

## Recomendaciones por escenario

### Asistente de servicio al cliente

Deja que la Skill recupere información, organice contexto y redacte una respuesta, mientras que SOUL.md mantiene al Agent profesional, claro y medido.

Para reembolsos, cambios de precio, verificaciones de identidad, eliminación de datos y otras acciones de alto riesgo, requiere que el Agent explique el impacto y espere a la confirmación humana.

Cuando el material de referencia es incompleto, el usuario está escalando, o la solicitud está fuera del alcance autorizado, deriva en lugar de adivinar.

### Asistente de comunidad

Deja que la Skill recupere preguntas frecuentes, extraiga puntos de discusión y redacte recordatorios, mientras que el breve de personalidad mantiene al Agent alineado con el tono de la comunidad y las reglas de administrador.

El acceso a grupos, disparadores de @mention, permisos y entrega de mensajes dependen del canal, así que lee la documentación relevante del canal antes de configurar el flujo de trabajo.

Si el canal objetivo no soporta actualmente chats de grupo, valida la Skill y flujo de contenido en una conversación 1 a 1 en lugar de tratar este artículo como un montaje de chat de grupo en vivo.

### Compañero de IA

Usa SOUL.md para el estilo de compañía estable, y usa memoria y el perfil de usuario para preferencias confirmadas y contexto a largo plazo.

Los recordatorios proactivos deben tener una frecuencia clara, método de pausa y horas de silencio, para que la iniciativa no se convierta en mensajería ilimitada.

Si quieres que Hermes retenga una preferencia, pídele que recuerde la preferencia en la conversación; si ya no quieres que se retenga, pídele que la olvide.

## Lista de verificación de seguridad

- Confirma la fuente de la Skill, permisos y dependencias de servicios externos antes de la instalación.

- Usa una conversación 1 a 1 y material de bajo riesgo durante las pruebas.

- Requiere confirmación antes de enviar mensajes externos, cambiar pedidos, eliminar archivos o tomar otras acciones irreversibles.

- Prepara una ruta de intervención humana para flujos de trabajo de servicio al cliente y comunidad.

- Revisa periódicamente la memoria, el perfil de usuario y Almacenamiento en la Nube, y elimina información que ya no se necesita.

## Preguntas frecuentes

### ¿Instalar una Skill cambiará automáticamente la personalidad del Agent?

No.

Las Skills expanden principalmente lo que el Agent puede hacer, mientras que la personalidad se define por SOUL.md y la configuración relacionada.

Las instrucciones de Skill y la salida pueden afectar el estilo de una tarea, pero no deben reemplazar tu rol estable y definiciones de límites.

### ¿Puede una Skill de servicio al cliente procesar reembolsos directamente?

Solo considera ese tipo de acción cuando los permisos del sistema, reglas de negocio y requisitos de confirmación humana estén todos explícitos.

Por defecto, deja que el Agent busque la política, redacte una recomendación y espere a la confirmación antes de la ejecución.

### ¿Puede un asistente de comunidad unirse directamente a un grupo de Telegram?

La documentación actual de Telegram de LightVela aún trata las conversaciones 1 a 1 como el alcance soportado, así que lee [Asistente de IA de Comunidad de Grupo de Telegram: Límites de Capacidad](./telegram-group-community-assistant.md) antes de planificar un flujo de trabajo de grupo.

### ¿Debo poner todo el material de referencia en la memoria?

No.

La memoria a largo plazo es para una pequeña cantidad de contexto estable, mientras que las preguntas frecuentes del producto, reglas de la comunidad y conjuntos de referencia grandes son mejor colocados en [Almacenamiento en la Nube](../configuration/files.md) o leídos a demanda por una Skill.

## Próximos pasos

- [Configurar Skills](../configuration/skill.md) - Revisa instalación, validación y guía de seguridad de Skills.

- [Cómo definir el Rol, Personalidad y Voz de un Agent de IM con SOUL.md](./im-agent-persona-soul-md.md) - Diseña una personalidad estable y límites de comportamiento.

- [Cómo Conectar un Agent a Telegram y WhatsApp Manteniendo una Personalidad y Memoria a Largo Plazo](./multi-channel-personality-memory.md) - Extiende las capacidades del mismo Agent a múltiples puntos de entrada.

- [Cómo Configurar un Asistente de IA de Comunidad de Grupo de Telegram](./telegram-group-community-assistant.md) - Revisa el límite actual de soporte de chat de grupo y lista de preparación.
