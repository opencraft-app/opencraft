# Configurar canal - WeChat

## Resumen

**El canal de WeChat se conecta mediante código QR y es el más sencillo de todos los canales para configurar: seleccione WeChat en la sección de Canales de la consola, haga clic para autorizar y generar un código QR, luego escárelo con WeChat en su teléfono para comenzar a hablar. Solo necesita dos cosas: un teléfono con WeChat instalado y un modelo configurado (o simplemente los créditos mensuales del modelo incluidos en su plan). Un Agent puede conectarse a varios canales a la vez, y todos comparten la misma personalidad y memoria a largo plazo.**

---

El canal de WeChat utiliza el acceso mediante código QR y es el canal más sencillo de configurar.

## Esta página cubre

- Generar un código QR de acceso a WeChat en LightVela

- Escanear el código QR con WeChat en su teléfono

- Chatear con Hermes Agent en WeChat


> 💡 **Requisitos previos**
>
> - Un teléfono con WeChat instalado
>
> - Completar la [configuración del modelo](./model.md) (o utilizar los 100 créditos de prueba incluidos en el plan Launch)
>

---

## Pasos

### 1. Ingresar a la consola

Inicie sesión en LightVela, haga clic en "Mi Hermes" en la esquina superior derecha para ingresar a la consola y busque el botón "Canales".

### 2. Seleccionar el canal de WeChat

Haga clic en la lista desplegable y seleccione "WeChat". Aparecerá la introducción del canal de WeChat y el enlace "Ver detalles" debajo.

### 3. Hacer clic en "Autorizar acceso"

Un código QR aparece en la página.

![](../images/20260424-142558-0pl3.webp)

> ⚠️ **Vencimiento del código QR**
>
> El código QR expira después de unos minutos. Si expira, cierre el diálogo y haga clic nuevamente en "Autorizar acceso" para generar un nuevo código QR.

### 4. Escanear con WeChat en su teléfono

1. Abra WeChat en su teléfono

2. Tache el "+" en la esquina superior derecha → "Escanear"

3. Escanee el código QR en la pantalla de su computadora

4. Siga las indicaciones en su teléfono para completar la autorización


### 5. Buscar Hermes Agent en WeChat

Después de que el escaneo tenga éxito:

- El diálogo se cierra automáticamente y se agrega un registro de "WeChat" a la lista de "Canales conectados" en la consola

- WeChat agrega automáticamente la cuenta del bot

Abra el chat con ese bot y envíe un mensaje de prueba:

```
Hi
```

Debería recibir una respuesta de Hermes Agent en unos segundos.

![](../images/6.1-2.webp)

---

## Estado de éxito

- La lista de "Canales conectados" en la consola contiene "WeChat"

- El bot correspondiente puede encontrarse en los contactos de WeChat

- Hermes Agent responde después de enviar un mensaje


---

## Tipos de mensajes soportados

Después de que el acceso tenga éxito, el bot de WeChat puede recibir y responder mensajes de texto básicos y soporta más tipos de mensajes como sigue:

| Tipo de mensaje soportado por el bot de WeChat | Soportado |
|---|---|
| Recibir mensajes de texto | ✅ Soportado |
| Recibir imágenes y videos | ✅ Soportado |
| Recibir archivos | ✅ Soportado |
| Recibir mensajes de voz | ✅ Soportado |
| Responder con mensajes de texto | ✅ Soportado |
| Responder con imágenes y videos | ✅ Soportado |
| Responder con archivos | ✅ Soportado |
| Enviar mensajes proactivamente (como recordatorios programados) | ✅ Soportado |

> ℹ️ **La capacidad de procesamiento real depende del modelo**
>
> La tabla de arriba solo indica los tipos de mensajes soportados por el bot de WeChat en la capa de canal. ¿Pueden procesarse realmente imágenes, archivos y otras tareas también depende de si el modelo de lenguaje grande conectado a Hermes Agent tiene las capacidades correspondientes.

---

## Preguntas frecuentes

| Problema | Posible causa | Solución |
|---|---|---|
| WeChat muestra "código QR inválido" después de escanear | El código QR ha expirado | Cierre el diálogo y haga clic nuevamente en "Autorizar acceso" |
| No hay respuesta en la computadora después de escanear | Retraso de red o autorización no completada | Actualice la consola para confirmar el estado; si el acceso no tuvo éxito, intente de nuevo |
| No se puede encontrar el contacto del bot en WeChat | El mensaje se ha doblado en "Notificaciones de servicio" | Busque "LightVela" o el nombre de Hermes Agent en la parte superior de WeChat |
| No hay respuesta después de enviar un mensaje | El modelo no está configurado o los créditos de prueba se han agotado | Verifique el estado de "Modelo actual" en la tarjeta "1. Modelo" |
| ¿Cómo desconectar? | — | Elimine el registro correspondiente en la lista de "Canales conectados" |
| ¿Puede la misma cuenta de WeChat conectarse a múltiples instancias de Hermes Agent? | El límite del plan Launch es 1 Hermes Agent | No aplica |

---

## Notas del canal

- **Tipos de mensaje**: Soporta texto, imágenes, videos, archivos, mensajes de voz y más. Vea "Tipos de mensajes soportados" de arriba

- **Soporte para chats grupales**: Los chats grupales no se soportan actualmente; solo se soportan conversaciones 1 a 1

- **Interrupción de conexión**: Los largos periodos de no respuesta pueden indicar que la autorización fue revocada. Vuelva a la consola y autorice el acceso nuevamente


---

## Próximos pasos

- [Configurar canal - Telegram](./channel-telegram.md) — Notificaciones ligeras y comunicación multiplataforma

- [Configurar canal - WhatsApp](./channel-whatsapp.md) — Comunicación con usuarios internacionales y servicio al cliente

- [Configurar canal - Discord](./channel-discord.md) — Operaciones comunitarias y comunidades de desarrolladores

- [Configurar canal - Slack](./channel-slack.md) — Colaboración en equipo, notificaciones de espacio de trabajo y flujos de trabajo de canal

- [Configurar Skills](./skill.md) — Extender las capacidades de Hermes Agent
