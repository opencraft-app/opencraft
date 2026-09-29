# Configurar tareas de notificación en LightVela

## Resumen

**Las Notification Tasks envían un mensaje fijo según un horario sin llamar a un modelo de IA ni gastar créditos de modelo.** Úsalas para recordar medicación, facturas o renovaciones; configura el mensaje, el horario, la ventana activa y el canal.

Las tareas de notificación son una aplicación sencilla para los agentes alojados en la nube porque pueden enviar un mensaje fijo según una programación sin llamar a un modelo de IA.
Úselas cuando necesite que un recordatorio llegue en el momento adecuado, por el canal adecuado y con las palabras exactas que proporcionó.
Los usuarios las han utilizado para recordatorios de agua y medicación, así como para avisos de facturas y renovaciones de suscripciones.

## Problemas comunes que las notificaciones pueden resolver

No solemos olvidar tareas importantes porque no nos importen.
Algunas acciones pequeñas pero necesarias son fáciles de pasar por alto cuando el trabajo se vuelve intenso.

- Olvida beber agua durante una sesión de trabajo larga.
- Toma la medicación más tarde de lo previsto.
- Una renovación de suscripción queda enterrada en la bandeja de entrada.
- Recuerda una factura solo después de su fecha de vencimiento.

En LightVela puede configurar una tarea de Notificación con un mensaje, una programación, una ventana de tiempo efectiva y un canal de entrega.
El mensaje se envía exactamente como se escribe sin llamar a un modelo, por lo que no consume tokens de modelo.
La documentación de [Tareas programadas](https://lightvela.ai/docs/configuration/automation?from=social_x) explica las opciones de programación y notificación disponibles.

## Caso 1: Recordatorios diarios de salud

Cada día a las 10:30 y a las 15:30, una tarea de Notificación envía el mismo recordatorio breve.

Mensaje:

> Es hora de beber un vaso de agua y tomar un descanso breve.

![Editar una tarea de notificación recurrente para recordatorios diarios de salud](../images/scheduled-task-notifications-1.webp)

La clave es mantener el mensaje corto y accionable.
Como no pasa por un modelo, la notificación no se reescribirá ni recibirá contexto adicional.

## Caso 2: Recordatorios mensuales de pagos

El primer día de cada mes, una tarea de Notificación le recuerda revisar los próximos pagos.

Mensaje:

> Revisión mensual de pagos: revise el alquiler, las facturas de servicios y las suscripciones que vencen esta semana.

![Editar una tarea de notificación mensual para recordatorios de pagos](../images/scheduled-task-notifications-2.webp)

La notificación mantiene visible cada pago antes de su vencimiento.
Si las facturas tienen fechas de vencimiento distintas, cree tareas separadas para que cada recordatorio llegue cuando sea útil.

## Actualizarme directamente en IM

LightVela le permite conectar su Agent a WhatsApp, Telegram, WeChat, Discord y más.
Puede conectar uno o varios canales al mismo tiempo.
En Tareas programadas, puede activar cada canal configurado para decidir dónde debe entregarse la notificación.

![Una notificación programada entregada directamente en Telegram](../images/scheduled-task-notifications-3.webp)

Después de activarla, Hermes enviará la notificación exacta directamente a su IM.
No necesita abrir LightVela ni otra aplicación para consultar el recordatorio.

## Gestionar varias tareas

Puede crear tantas tareas programadas como necesite.
Después de crearlas, puede editar su contenido y programación, pausarlas y consultar ejecuciones anteriores.
Con LightVela, su Hermes Agent personal puede mantener las rutinas importantes según lo previsto mientras usted se concentra en otro trabajo.

![Lista de trabajos actuales con tareas de notificación](../images/scheduled-task-notifications-4.webp)
