# Cómo configurar servicio de atención al cliente de IA 24/7 en WhatsApp: Personalidad, conocimiento, Skills y tareas programadas

## Resumen

**WhatsApp puede servir como un punto de entrada uno a uno entre los clientes y un Hermes Agent, útil para responder preguntas recurrentes, captar las necesidades del cliente y redactar respuestas. Pero "24/7" aquí significa que puede responder cuando el servicio esté en funcionamiento, el modelo esté disponible y el canal esté conectado — no es una garantía de servicio ininterrumpido ni un SLA de soporte humano.** Una segunda restricción es tan importante: el envío proactivo de mensajes en WhatsApp sigue sujeto a ventanas de conversación, mensajes de plantilla y configuración del canal, por lo que los recordatorios automatizados deben diseñarse por separado de las conversaciones iniciadas por el cliente, en lugar de asumir que puede enviar a su antojo. Construya en cuatro capas, en orden: la personalidad establece la voz y las condiciones de escalación, el conocimiento captura las preguntas frecuentes, las Skills agregan procedimientos reutilizables y las tareas programadas manejan los resúmenes programados.

![Configurando servicio de atención al cliente de IA 24/7 en WhatsApp](../images/use-case-09-whatsapp-24-7-customer-service.png)

## Para quién es esto

Esta guía es para personas que desean desplegar un Agent de soporte personal, un asistente de información de producto o un asistente de triaje postventa en WhatsApp.

Es especialmente útil para equipos que necesitan un lenguaje de soporte consistente, FAQs mantenibles, menos respuestas repetitivas y una ruta clara de transferencia para solicitudes complejas.

## Requisitos previos

- Un Hermes Agent LightVela en funcionamiento.
  Si aún no ha creado uno, comience con [Quickstart](../02-quickstart.md).

- Una configuración de modelo funcional o créditos de prueba disponibles.

- Una cuenta de WhatsApp usable conectada siguiendo [Configure Channel - WhatsApp](../configuration/channel-whatsapp.md).

- Material de producto, horarios de servicio, rutas de escalación y datos de contacto humano.

- Una definición clara de las acciones que requieren ejecución o confirmación humana.

## Comprender las cinco capas de servicio al cliente 24/7

| Capa | Responsabilidad | Ubicación adecuada |
|---|---|---|
| Personalidad | Rol, voz, prioridades y límites de servicio | SOUL.md o [Personality](./im-agent-persona-soul-md.md) |
| Conocimiento | FAQs de producto, políticas, horarios de servicio y rutas de escalación | Archivos de referencia en [Cloud Storage](../configuration/files.md) |
| Skills | Búsqueda, organización, redacción y otras acciones concretas | [Skills](../configuration/skill.md) |
| Memoria | Preferencias confirmadas del cliente y contexto de colaboración duradero | [Memory Management](../configuration/memory.md) |
| Tareas programadas | Verificaciones programadas, recordatorios internos y avisos proactivos | [Tareas programadas](../configuration/automation.md) |

No coloque una gran base de conocimientos de producto en la personalidad, y no trate el contenido del cliente no confirmado como memoria a largo plazo.

## Pasos

### 1. Conectar y verificar una conversación 1 a 1 en WhatsApp

En la configuración del canal del Hermes Agent objetivo, seleccione WhatsApp y complete la autorización QR siguiendo [Configure Channel - WhatsApp](../configuration/channel-whatsapp.md).

Abra el contacto correspondiente en WhatsApp y envíe un mensaje de prueba, luego confirme que la consola muestre el canal como conectado y que la respuesta llegue normalmente.

El canal de WhatsApp actual no soporta chats de grupo, por lo que este flujo de servicio al cliente está diseñado para conversaciones 1 a 1 con el cliente.

### 2. Redactar un breve de personalidad de servicio al cliente

Utilice la [guía de personalidad SOUL.md](./im-agent-persona-soul-md.md) para definir la identidad, voz, orden de respuesta y límite de escalación del asistente de soporte.

Comience con un breve como este:

    You are our product support assistant.
    Give the customer the most important conclusion first, followed by the necessary steps.
    Answer only from confirmed product material, and clearly suggest a human handoff when uncertain.
    Do not promise refunds, price changes, identity checks, data deletion, or other high-risk outcomes.
    Before sending content to an external system or making a change, explain the impact and wait for human confirmation.

Mantenga principios de servicio estables en la personalidad y mantenga respuestas concretas de producto en archivos de referencia mantenibles.

### 3. Organizar la base de conocimientos de soporte

Prepare al menos estas categorías:

- FAQs de producto y planes.

- Horarios de servicio, expectativas de respuesta y datos de contacto humano.

- Políticas de reembolso, cancelación, actualización e incidentes.

- Errores comunes y pasos de solución de problemas.

- Solicitudes que requieren transferencia humana y la información que se debe recopilar antes de la transferencia.

Divida el material en archivos de tema mantenibles y colóquelos en [Cloud Storage](../configuration/files.md).

Pruebe el material con una pregunta de bajo riesgo:

    Answer this question only from the prepared support material.
    If the material does not contain an answer, say what information is missing and suggest a human handoff.

### 4. Instalar y validar las Skills necesarias

Si necesita recuperación de conocimiento, organización de tickets, búsqueda web o generación de contenido, seleccione una Skill confiable de [Skills.sh](https://skills.sh/) o [ClawHub](https://clawhub.ai/).

Antes de pedirle a Hermes que la instale a través de WhatsApp, pregunte qué lee la Skill, qué servicios externos llama y si puede enviar mensajes proactivos.

Las Skills de alto riesgo pueden solicitar confirmación secundaria antes de la instalación, por lo que revise los permisos y la guía de seguridad en [Configure Skills](../configuration/skill.md).

Después de la instalación, pruebe borradores, resúmenes y recuperación de FAQs antes de permitir que ninguna Skill procese reembolsos, elimine datos o envíe contenido de cliente sin revisar.

### 5. Establecer preferencias del cliente y memoria duradera

Solo la información que está confirmada y útil para el servicio futuro debe guardarse en la memoria o en el perfil de usuario.

Ejemplos incluyen una preferencia confirmada por inglés, una preferencia por respuestas que priorizan la conclusión o el estado de un caso de soporte en curso que el cliente ha verificado.

Las contraseñas, códigos de verificación, detalles de pago, información de identidad completa y datos sensibles innecesarios no deben guardarse como memoria a largo plazo.

Pida a Hermes que recuerde u olvide una preferencia durante la conversación y revise periódicamente la página [Memory Management](../configuration/memory.md) en la consola.

### 6. Configurar tareas programadas y mensajes proactivos

Buenas candidatas para tarea programada incluyen recordatorios de tareas internas, verificaciones de casos sin resolver y resúmenes de servicio diarios.

Configure el horario, la ventana de tiempo activa y el método de notificación en [Tareas programadas](../configuration/automation.md).

Los mensajes proactivos de WhatsApp pueden estar limitados por ventanas de conversación o plantillas de mensajes aprobadas, por lo que no asuma que un texto normal siempre se puede entregar cuando el cliente no ha iniciado una conversación.

Use un número de prueba primero para verificar la entrega, el contenido y la ruta de manejo interna cuando una notificación falle.

### 7. Establecer la transferencia humana

Cuando una solicitud involucre reembolsos, pagos, verificaciones de identidad, compromisos legales, quejas escaladas o material de referencia faltante, el Agent de soporte debe dejar de adivinar y transferir a un humano.

El mensaje de transferencia debe incluir los hechos conocidos, la información faltante, el siguiente paso recomendado y si el cliente necesita repetir el problema.

Revise una muestra de conversaciones cada día, centrándose en citas erróneas, promesas excesivas, manejo de datos sensibles y mensajes proactivos repetidos.

## Un orden de respuesta de soporte reutilizable

1. Entregar la conclusión directa.

2. Citar el material más relevante o los pasos.

3. Explicar restricciones, costos, tiempos o información requerida.

4. Establecer claramente cuándo se necesita una transferencia humana.

5. Ejecutar una acción externa solo cuando esté permitido y confirmado.

## FAQ

### ¿Significa 24/7 que WhatsApp siempre responderá inmediatamente?

No.

El Agent debe estar en funcionamiento, el modelo debe estar disponible, el canal de WhatsApp debe permanecer conectado y la entrega proactiva puede estar limitada por ventanas de conversación y plantillas de mensajes.

### ¿Puede el servicio al cliente de WhatsApp manejar chats de grupo?

La documentación actual del canal de WhatsApp indica que los chats de grupo no se soportan y solo se soportan conversaciones 1 a 1.

Si necesita servicio al cliente de grupo, primero confirme que otro canal objetivo tenga documentación explícita de soporte de grupo en lugar de inferir el soporte de grupo del comportamiento 1 a 1.

### ¿Debería el material de soporte ir a la memoria o a Cloud Storage?

Las FAQs de producto, políticas y colecciones de referencia grandes pertenecen a Cloud Storage.

La memoria y el perfil de usuario son mejores para una pequeña cantidad de preferencias estables del cliente, hechos confirmados y contexto de colaboración duradero.

### ¿Puede una Skill enviar mensajes a los clientes automáticamente?

Solo cuando la capacidad del canal, la autorización empresarial, las plantillas de mensajes y las reglas de revisión humana sean explícitas.

Por defecto, deje que la Skill cree un borrador o recordatorio interno, luego que un humano confirme lo que debe enviarse.

## Próximos pasos

- [Configure Channel - WhatsApp](../configuration/channel-whatsapp.md) - Complete la conexión 1 a 1 de WhatsApp.

- [Cómo convertir un Agent de IM en un asistente de servicio al cliente, comunidad o compañero con Skills](./im-agent-skill-scenarios.md) - Elija y valide Skills de servicio al cliente.

- [Cómo definir el rol, personalidad y voz de un Agent de IM con SOUL.md](./im-agent-persona-soul-md.md) - Defina la personalidad de soporte y los límites de comportamiento.

- [Tareas programadas](../configuration/automation.md) - Configure recordatorios internos y resúmenes programados.
