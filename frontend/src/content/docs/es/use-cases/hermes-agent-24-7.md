# Cómo mantener un Hermes Agent en línea las 24 horas

## Resumen

**Un Hermes Agent permanece disponible las 24 horas porque se ejecuta en una instancia en la nube en lugar de en su máquina local. Una vez que se configura un modelo y al menos un canal, utiliza la misma memoria y comportamiento sin importar desde qué punto de entrada se le envíe un mensaje.** Tres cosas deben estar en lugar para una disponibilidad real a largo plazo: un modelo configurado con cuota de cuenta utilizable (los créditos de prueba agotados causan silenciosamente no-respuestas), al menos un canal que aparezca conectado y tareas programadas para cubrir el trabajo programado mientras usted está ausente. No juzgue la disponibilidad solo desde el estado del consola — envíe un mensaje real a través de un canal real. Cuando algo se rompe, vea y exporte los registros recientes en Diagnostics (seleccionable en rangos de 1, 3, 6, 12 o 24 horas) para localizar la causa.

![Un Hermes Agent en línea en la consola LightVela](../images/use-case-hermes-online.webp)

## Para quién es esto

Utilice este patrón si desea un asistente al que pueda acceder desde su teléfono, un canal de equipo o la consola sin tener que mantener una computadora encendida. También es una buena opción para rutinas programadas como un informe diario, un recordatorio o una verificación de estado recurrente.

Estar en línea no es lo mismo que estar sin supervisión. Debería seguir eligiendo Skills confiables, revisar instrucciones recurrentes y verificar que el modelo y el canal continúen funcionando como se espera.

## Requisitos previos

- Un Hermes Agent en ejecución en su consola LightVela. [Quickstart](../02-quickstart.md) cubre la configuración de cuenta y la primera creación.

- Una configuración de modelo funcional o créditos de prueba disponibles. Hermes necesita un modelo antes de poder generar respuestas.

- Al menos un canal conectado, como Telegram, WhatsApp, Discord, Slack o WeChat, para que tenga una manera práctica de acceder a él.

- Una tarea recurrente opcional si desea que Hermes haga más que esperar mensajes.

## Pasos / conceptos clave

### 1. Hacer que el Agent sea accesible desde un canal que realmente utiliza

Elija un canal como su método predeterminado de contacto con Hermes. Para uso personal, la mejor opción suele ser la aplicación que ya revisa varias veces al día. Conéctela, envíe un mensaje de prueba breve y asegúrese de que Hermes responda antes de agregar más configuración.

Las instrucciones detalladas están disponibles para [Telegram](../configuration/channel-telegram.md), [WhatsApp](../configuration/channel-whatsapp.md), [Discord](../configuration/channel-discord.md), [Slack](../configuration/channel-slack.md) y [WeChat](../configuration/channel-wechat.md).

![Un Hermes Agent en ejecución con canales conectados](../images/use-case-hermes-online-channel.png)

### 2. Mantener la configuración funcional simple y visible

Las piezas importantes son el modelo activo, los canales conectados, las Skills instaladas y la memoria. No necesita cambiarlas a menudo, pero ayuda saber dónde se encuentran cuando una respuesta no llega o una tarea necesita nuevas capacidades.

Utilice [Configure Models](../configuration/model.md) para verificar el modelo activo y mantenga un registro del proveedor o de la situación de créditos de prueba. Si instala Skills, agregue solo las necesarias para un flujo de trabajo real y revíselas en [Configure Skills](../configuration/skill.md).

### 3. Usar memoria para mantener al asistente continuo

Un asistente que siempre esté encendido se vuelve más útil cuando no comienza desde cero. Le diga a Hermes las preferencias y el contexto de trabajo que desea llevar en futuras conversaciones, luego revíselas de vez en cuando en [Memory Management](../configuration/memory.md).

Por ejemplo:

```text
Remember that I prefer updates in bullet points and that urgent work
should be labeled clearly.
```

Esto permite que un mensaje enviado desde un dispositivo diferente o un canal soportado continúe la misma relación de trabajo en lugar de comenzar con una página en blanco.

### 4. Agregar una tarea programada cuando la disponibilidad debe llevar a la acción

Un Hermes en línea puede esperar sus mensajes, pero una pequeña tarea programada le permite comenzar una rutina conocida en el momento adecuado. Comience con una tarea que tenga una condición de éxito clara:

```text
Every weekday at 8:30 AM, prepare a short briefing with today’s
calendar priorities, open follow-ups, and the first action to take.
```

Cree el horario en [Tareas programadas](../configuration/automation.md), seleccione un canal de notificación si es apropiado y verifique los primeros ejecuciones. Si el resultado es demasiado amplio, haga la instrucción más específica en lugar de agregar otra tarea programada inmediatamente.

![Ejecuciones recientes de tarea programada desde un Hermes Agent](../images/use-case-hermes-online-automation.png)

## Preguntas frecuentes

### ¿Necesita Hermes mi laptop para permanecer encendida?

No. Hermes se ejecuta en el entorno en la nube de LightVela, por lo que puede cerrar su dispositivo local después de que el Agent y su canal estén configurados.

### ¿Por qué Hermes está en línea pero no responde?

Verifique primero la conexión del canal y el estado del modelo activo o la situación de créditos de prueba. Si recientemente cambió la configuración, permita que la actualización termine, luego envíe nuevamente un mensaje de prueba simple. La página [Diagnostics](../configuration/diagnostics.md) puede ayudar con el mantenimiento y los registros recientes.

### ¿Puedo conectar más de un canal?

Sí. Los canales soportados pueden apuntar al mismo Hermes Agent. Comparten el mismo comportamiento del Agent y la memoria, por lo que elija un canal predeterminado y agregue otros solo cuando resuelvan una necesidad real de acceso.

### ¿Es seguro automatizar un Agent de 24/7?

Utilice solo instrucciones bien delimitadas y Skills confiables. Comience con rutinas de solo lectura o de bajo riesgo, revise la salida y evite dar a una tarea programada autoridad para realizar acciones que no desearía repetir automáticamente.

## Próximos pasos

- [Tareas programadas](../configuration/automation.md) — programe el trabajo que debe realizarse sin una solicitud manual.

- [Memory Management](../configuration/memory.md) — mantenga preferencias útiles disponibles entre conversaciones.

- [Diagnostics](../configuration/diagnostics.md) — investigue un problema de canal o modelo cuando Hermes no responda.
