# Configurar canal - WhatsApp

## Resumen

**El canal de WhatsApp se conecta mediante código QR, al igual que WeChat, lo que lo convierte en una forma rápida de integrar a Hermes Agent en las conversaciones de WhatsApp: seleccione WhatsApp en la sección de Canales de la consola, genere el código QR y escáñelo con WhatsApp en su teléfono para comenzar a hablar. Necesita un teléfono con WhatsApp instalado y un modelo configurado (o simplemente los créditos mensuales del modelo incluidos en su plan). Un Agent puede conectarse a varios canales simultáneamente, compartiendo la misma personalidad y memoria a largo plazo.**

---

El canal de WhatsApp utiliza acceso mediante código QR, similar a WeChat, y es adecuado para conectar rápidamente a Hermes Agent a las conversaciones de WhatsApp.

## Este documento cubre

- Escanear un código QR con WhatsApp en su teléfono para autorizar el acceso
- Chatear con Hermes Agent en WhatsApp


> 💡 **Requisitos previos**
>
> - Un teléfono con WhatsApp instalado
>
> - Completar la [configuración del modelo](./model.md) (o utilizar los 100 créditos de prueba incluidos en el plan Launch)
>

---

## Pasos

### 1. Ingresar a la consola

Inicia sesión en LightVela, abre el Agent deseado y selecciona **Channels** en la barra lateral.

### 2. Seleccionar el canal de WhatsApp

Busque la tarjeta de WhatsApp y haga clic en "+ Conectar".

En una misma instancia de LightVela, WhatsApp solo puede estar conectado a un Bot a la vez. Si ya está conectado a otro Bot, abra ese Bot desde el aviso y desconecte WhatsApp antes de conectarlo aquí.

### 3. Escanear el código QR en WhatsApp

Usa WhatsApp en el teléfono para escanear el código que muestra LightVela y sigue las instrucciones de la aplicación para autorizar la sesión vinculada. Si caduca, genera otro desde la tarjeta de WhatsApp. Vuelve a **Channels** y comprueba que WhatsApp aparece conectado.

### 4. Encuentre a sí mismo en WhatsApp

![](../../images/whatsapp-2-global.webp)

Chatee consigo mismo — eso es su bot.

Abra la conversación con el bot y envíe un mensaje de prueba:

```
Hi
```

Debería recibir una respuesta de Hermes Agent en unos pocos segundos.

![](../../images/whatsapp-3-global-en.webp)

---

## Estado de éxito

- La lista de "Canales conectados" en la consola contiene "WhatsApp"
- El bot correspondiente puede encontrarse en los contactos de WhatsApp
- Hermes Agent responde después de enviar un mensaje


---

## Tipos de mensajes soportados

Después de que el acceso sea exitoso, el bot de WhatsApp puede recibir y responder mensajes de texto básicos y soporta más tipos de mensajes como sigue:

| Tipo de mensaje soportado por el bot de WhatsApp | Soportado |
|---|---|
| Recibir mensajes de texto | ✅ Soportado |
| Recibir imágenes y videos | ✅ Soportado |
| Recibir archivos | ✅ Soportado |
| Responder con mensajes de texto | ✅ Soportado |
| Responder con imágenes y videos | ✅ Soportado |
| Responder con archivos | ✅ Soportado |
| Enviar mensajes proactivos (como recordatorios programados) | ✅ Soportado |

> ℹ️ **La capacidad de procesamiento real depende del modelo**
>
> La tabla de arriba solo indica los tipos de mensajes soportados por el bot de WhatsApp en la capa de canal. Si las imágenes, archivos y otras tareas pueden procesarse realmente también depende de si el modelo de lenguaje grande conectado a Hermes Agent tiene las capacidades correspondientes.

---

## Preguntas frecuentes

| Problema | Qué revisar | Acción |
|---|---|---|
| El código QR no se escanea o ha caducado | Conexión del teléfono y código actual | Genera otro desde la tarjeta de WhatsApp y sigue las instrucciones de la aplicación. |
| No aparece la conexión | Si terminó la autorización en el teléfono | Vuelve a **Channels**, actualiza una vez y reconecta si sigue desconectado. |
| No hay respuesta | Estado del Agent, canal y créditos | Revisa **Channels** y [Diagnostics](./diagnostics.md); consulta las [opciones de créditos](../credits.md) si hace falta. |
| No llegan mensajes programados | Conexión del canal y ejecución de la tarea | Revisa la última ejecución en [Scheduled Tasks](./automation.md) y el destino de la notificación. |
| Otro Bot usa WhatsApp | Solo un Bot por instancia puede conectarse a WhatsApp | Desconéctalo del Bot anterior antes de conectarlo al nuevo. |

---

## Notas del canal

- **Tipos de mensaje**: Soporta texto, imágenes, videos, archivos, mensajes de voz y más. Vea "Tipos de mensajes soportados" de arriba
- **Soporte para chats grupales**: Los chats grupales no se soportan actualmente; solo se soportan conversaciones 1 a 1
- **Interrupción de conexión**: Los largos periodos de no respuesta pueden indicar que la autorización fue revocada. Vuelva a la consola y autorice el acceso nuevamente

---

## Próximos pasos

- [Configurar canal - Discord](./channel-discord.md) — Operaciones comunitarias y comunidades de desarrolladores
- [Configurar canal - Slack](./channel-slack.md) — Colaboración de equipos, notificaciones de espacio de trabajo y flujos de trabajo de canales
- [Configurar canal - QQ](./channel-qq.md) — Bot creado manualmente, integrado mediante AppID/AppSecret
- [Configurar canal - WeCom](./channel-wecom.md) — Colaboración interna empresarial y escenarios de oficina
- [Configurar Skills](./skill.md) — Extender las capacidades de Hermes Agent
