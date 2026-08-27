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

Inicie sesión en LightVela, haga clic en "Mi Hermes" en la esquina superior derecha para ingresar a la consola y busque el botón "Canales".

### 2. Seleccionar el canal de WhatsApp

Busque la tarjeta de WhatsApp y haga clic en "+ Conectar".

### 3. Escanear el código QR con WhatsApp en su teléfono

1. Abra WhatsApp en su teléfono
2. Toca el botón "Cámara" en la esquina superior derecha
3. Escanee el código QR en su pantalla de computadora

![](../images/whatsapp-1-global-en.webp)

4. Siga las indicaciones en su teléfono para completar la conexión

### 4. Encuentre a sí mismo en WhatsApp

![](../images/whatsapp-2-global.webp)

Chatee consigo mismo — eso es su bot.

Abra la conversación con el bot y envíe un mensaje de prueba:

```
Hi
```

Debería recibir una respuesta de Hermes Agent en unos pocos segundos.

![](../images/whatsapp-3-global-en.webp)

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

| Problema | Posible causa | Solución |
|---|---|---|
| No se puede conectar a WhatsApp | El formato del número de teléfono es incorrecto, o la configuración de WhatsApp Business es incompleta | Utilice un formato internacional completo como +1 o +86, y verifique que la configuración de WhatsApp Business / Meta sea completa |
| El código de verificación no se recibe | El número de teléfono no está disponible, retraso de red o límites de verificación de WhatsApp | Confirme que el número de teléfono pueda recibir mensajes de WhatsApp; espere unos minutos e intente de nuevo |
| El código de verificación muestra como inválido después de ingresar | El código expiró o se ingresó incorrectamente | Solicite un nuevo código y confirme que no haya espacios extra |
| No hay respuesta en la consola después del acceso | La autorización o la configuración no se ha sincronizado aún | Actualice la consola para confirmar el estado; si el acceso no fue exitoso, intente de nuevo |
| No se puede encontrar el contacto del bot en WhatsApp | El número del bot no se guardó, o la conversación no se ha iniciado | Guarde el número del bot, o abra la conversación mediante el enlace / código QR proporcionado por la consola |
| No hay respuesta después de enviar un mensaje | El modelo no está configurado, los créditos de prueba se han agotado, o el canal de WhatsApp no se ha conectado exitosamente | Verifique el estado de "Modelo actual" en la tarjeta "1. Modelo" y confirme que el canal de WhatsApp muestre como conectado |
| No se pueden recibir imágenes, archivos o mensajes de voz | Permiso de medios, formato o límites de capacidad del canal | Confirme que el tipo de archivo sea soportado; si el reconocimiento de voz no funciona, verifique si el reconocimiento de voz a texto / procesamiento de medios está habilitado |
| Los mensajes proactivos fallan | WhatsApp limita los mensajes proactivos mediante plantillas de mensajes y ventanas de conversación | Confirme que el usuario haya iniciado una conversación con el bot; si la ventana de conversación ha expirado, utilice una plantilla de mensaje aprobada |
| Cómo desconectar | — | Elimine el registro de WhatsApp correspondiente en la lista de "Canales conectados" |
| ¿Puede el mismo número de WhatsApp conectarse a múltiples instancias de Hermes Agent | No se recomienda; un número de WhatsApp debe estar vinculado a un Hermes Agent | Si necesita múltiples instancias de Hermes Agent, utilice números de WhatsApp separados |

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
