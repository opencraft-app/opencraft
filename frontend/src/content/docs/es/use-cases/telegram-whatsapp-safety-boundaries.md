# Cómo diseñar límites de seguridad para Agents de Telegram y WhatsApp: Autorización, reglas de grupo y acciones sensibles

## Resumen

**El límite de seguridad de un Agent no se determina solo por el modelo. Se construye a partir de cuatro capas: credenciales del canal, alcance de la conversación, política de memoria y reglas para acciones externas.** Un límite claro te permite responder cuatro preguntas de forma definitiva: ¿quién puede acceder a este Agent?, ¿qué mensajes se procesan?, ¿qué contenido nunca debe enviarse?, y ¿qué acciones requieren confirmación primero? Prácticas clave: las credenciales son sensibles y nunca deben colocarse en el contexto a largo plazo ni pegarse en el chat; la política de memoria debe evitar convertir datos sensibles en un registro permanente; y todo lo que se envía externamente o es irreversible necesita una etapa de confirmación. Ten en cuenta que Telegram y WhatsApp actualmente soportan conversaciones uno a uno como modo principal, por lo que las reglas de chat de grupo sirven como pruebas de diseño y prelanzamiento en lugar de configuraciones configurables hoy. Trabaja a través de la lista de verificación de seguridad antes de ponerlo en producción.

![Diseño de autorización, reglas de grupo y límites de acciones sensibles para Agents de Telegram y WhatsApp](../images/use-case-11-telegram-whatsapp-safety-boundaries.png)

## Para quién es este documento

Esta guía está dirigida a usuarios individuales, líderes de soporte y administradores de equipo que conectan un Agent de IM a la rutina diaria.

Es útil para equipos que desean definir el alcance de autorización, límites de datos y procedimientos de acciones de alto riesgo antes de conectar un Bot o una cuenta de WhatsApp.

## Cuatro capas de límites de seguridad

| Capa | Pregunta a responder | Controles típicos |
|---|---|---|
| Autorización | ¿Quién puede conectarse y usar este Agent? | Token del Bot, cuenta autorizada por QR, registros de conexión, permisos de cuenta |
| Conversación | ¿Qué conversaciones se procesan y responden? | Alcance 1 a 1, estado de grupo, disparadores de @mention, listas de autorización |
| Datos | ¿Qué contenido puede leerse o retenerse? | Redacción, Almacenamiento en la nube, memoria, perfil de usuario, política de eliminación |
| Acciones | ¿Qué acciones pueden ejecutarse automáticamente? | Mínimo privilegio, confirmación humana, registro de auditoría, transferencia humana |

Comienza con el alcance más pequeño útil y expande los permisos solo cuando la utilización real lo requiera.

## Pasos

### 1. Confirmar el objetivo de autorización para cada canal

Telegram se conecta mediante un Token de Bot, mientras que WhatsApp se conecta mediante autorización por QR.

Antes de conectar, confirma la relación entre el Bot, la cuenta de WhatsApp y el Agent Hermes objetivo, e ingresa las credenciales solo en la configuración del canal LightVela correspondiente.

Los Tokens de Bot de Telegram, sesiones de inicio de sesión de WhatsApp, códigos de verificación y otras credenciales no deben enviarse en chats ordinarios ni escribirse en documentos, tickets o repositorios.

El mismo Bot de Telegram o número de WhatsApp generalmente no debe estar vinculado a múltiples Agents Hermes, para que la gente pueda saber qué Agent recibe un mensaje.

Después de conectar, envía un mensaje de prueba de bajo riesgo, confirma que la respuesta regresa al contacto esperado y revisa la lista de canales conectados en la consola.

### 2. Limitar el alcance del canal a las capacidades actuales

Telegram y WhatsApp actualmente no soportan chats de grupo y solo soportan conversaciones uno a uno.

No inferas el soporte de grupos de LightVela de la configuración de privacidad de BotFather de Telegram ni del hecho de que WhatsApp en sí puede crear grupos.

Si un canal objetivo agrega soporte para grupos más tarde, primero define grupos permitidos, administradores, miembros, comportamiento de @mention y límites de tasa de mensajes.

Antes del lanzamiento de grupos, también confirma si los mensajes de los miembros entran en la memoria compartida y cómo prevenir que la información de un miembro se muestre a otro.

### 3. Establecer límites de contenido de mensajes

No envíes contraseñas, claves de API, tokens de acceso, códigos de verificación, información de pago, detalles de identidad completos, detalles médicos o datos de privacidad del cliente innecesarios al Agent.

Si se debe discutir un caso de negocio real, elimina nombres, números de teléfono, direcciones, números de pedido y otra información que pueda identificar a una persona u organización.

Usa reglas más estrictas en canales de colaboración de varias personas y externos porque los mensajes pueden ser visibles para más miembros, reenviados o retenidos por más tiempo.

### 4. Mantener la memoria y los archivos dentro del alcance mínimo necesario

Coloca reglas estables de rol, voz y límites en la [configuración de personalidad SOUL.md](./im-agent-persona-soul-md.md).

Mantén preferencias confirmadas y contexto de colaboración duradero a través de [Gestión de Memoria](../configuration/memory.md).

Mantén material de producto, preguntas frecuentes de soporte y archivos de referencia grandes en [Almacenamiento en la nube](../configuration/files.md) en lugar de poner cada mensaje de chat crudo en la memoria a largo plazo.

Revisa la memoria, el perfil de usuario y el almacenamiento en la nube regularmente, y elimina información que ya no se necesita o que no debe retenerse.

### 5. Establecer un umbral de confirmación para acciones sensibles

Las acciones que normalmente requieren confirmación humana incluyen:

- Enviar mensajes externos o publicar contenido.
- Cambiar pedidos, precios, suscripciones, permisos o detalles de cuenta.
- Devoluciones, pagos, verificaciones de identidad o compromisos legales.
- Eliminar archivos, memoria, datos de usuario u otros datos irreversibles.
- Ejecutar comandos que afectan entornos de producción o sistemas de terceros.

El Agent puede leer material, organizar riesgos y redactar una propuesta primero, pero debe explicar el impacto, el objetivo y la reversibilidad antes de la ejecución y esperar una confirmación explícita.

No trates una pregunta del usuario como autorización para ejecutar una acción.

### 6. Agregar límites para Skills y automatizaciones

Antes de instalar una Skill, confirma su fuente, permisos, APIs externas, acceso a archivos y capacidad de mensajes proactivos.

Prueba nuevas Skills en una conversación 1 a 1 con material de bajo riesgo antes de expandir su uso.

Cada automatización necesita un horario explícito, ventana de tiempo activa, método de notificación, canal objetivo y método de pausa.

Para mensajes proactivos de WhatsApp, también considera ventanas de conversación y plantillas de mensajes en lugar de asumir que el texto ordinario siempre se enviará.

### 7. Diseñar fallos y transferencia humana

Cuando el Agent está incierto, no puede citar su material, recibe contenido sensible, encuentra autorización poco clara o encuentra una queja, debe detener la ejecución automatizada y transferir a un humano.

El registro de transferencia debe incluir el disparador, el contenido ya procesado, las acciones pendientes y el siguiente paso recomendado.

Si las credenciales pueden haberse expuesto, deja de usar el canal afectado y revoca, restablece o reautoriza a través del procedimiento de la plataforma.

## Lista de verificación de seguridad prelanzamiento

- ¿Está cada Bot de Telegram o cuenta de WhatsApp mapeado a un Agent claro?
- ¿Has confirmado que las credenciales no aparecen en chats, documentos, código o registros?
- ¿Has confirmado que el flujo de trabajo actual usa conversaciones 1 a 1 en lugar de tratar chats de grupo no soportados como disponibles?
- ¿Has definido qué memoria puede retener, qué archivos pueden acceder y cómo funciona la eliminación?
- ¿Las acciones sensibles, mensajes externos y cambios irreversibles requieren confirmación?
- ¿Las Skills y automatizaciones tienen mínimo privilegio, un canal objetivo explícito y un método de pausa?
- ¿Tienes procedimientos para credenciales expuestas, mensajes erróneos y transferencia humana?

## Preguntas frecuentes

### ¿Pueden Telegram y WhatsApp usar la misma política de seguridad?

Pueden compartir los principios, pero las diferencias del canal aún importan.

Ambos deben proteger credenciales, restringir contenido sensible y requerir confirmación para acciones de alto riesgo, mientras que la autorización, límites de mensajes proactivos y formatos de mensaje deben verificarse por separado.

### ¿Hacer que el modo de privacidad del Bot de Telegram desactivado haga que el uso de grupos sea seguro?

No necesariamente.

El modo de privacidad cambia cómo un Bot recibe mensajes, pero no reemplaza el soporte de LightVela para el procesamiento de grupos que actualmente no está expuesto.

### ¿Puede el Agent eliminar automáticamente la memoria o archivos?

La eliminación, sobrescritura y otras acciones irreversibles deben requerir confirmación y una explicación del objetivo e impacto.

Incluso una solicitud de olvido conversacional debe identificar la información intencionada claramente en lugar de interpretarse como una solicitud de eliminación masiva.

### ¿Puede un Agent de atención al cliente emitir devoluciones o cambiar pedidos directamente?

No por defecto.

A menos que los permisos del sistema, la persona autorizada, el flujo de confirmación y los requisitos de auditoría sean explícitos, deja que el Agent redacte una recomendación y transfiera el caso a un humano.

### ¿Qué pasa si no sé si la información es sensible?

Redacta primero, o no la envíes.

Usa datos ficticios para solicitar plantillas, flujos de trabajo o consejos de seguridad en lugar de enviar credenciales reales o datos de privacidad del cliente.

## Próximos pasos

- [Configurar Canal - Telegram](../configuration/channel-telegram.md) - Revisa la configuración del Bot de Telegram y el alcance actual de mensajes.
- [Configurar Canal - WhatsApp](../configuration/channel-whatsapp.md) - Revisa la autorización de WhatsApp y límites de mensajes proactivos.
- [Cómo conectar un solo Agent a Telegram y WhatsApp manteniendo una sola personalidad y memoria a largo plazo](./multi-channel-personality-memory.md) - Entiende los límites de una configuración de Agent compartido.
- [Configurar Skills](../configuration/skill.md) - Revisa permisos de Skill y prompts de instalación de alto riesgo.
