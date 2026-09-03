# Configurar canal - WeCom

## Resumen

**El canal de WeCom se conecta mediante código QR y, junto con WeChat, es el más sencillo de configurar — una buena opción para utilizar Hermes Agent en un entorno corporativo: seleccione WeCom en la sección de Canales de la consola, haga clic para autorizar y generar un código QR, luego escárelo con WeCom en su teléfono para comenzar a hablar. Necesita un teléfono con WeCom instalado y un modelo configurado (o simplemente los créditos mensuales del modelo incluidos en su plan). Un Agent puede conectarse a varios canales simultáneamente, compartiendo la misma personalidad y memoria a largo plazo.**

---

El canal de WeCom utiliza acceso mediante código QR y es el canal más sencillo de configurar.

## Este documento cubre

- Generar un código QR de acceso de WeCom en LightVela
- Escanear el código QR con WeCom en su teléfono
- Chatear con Hermes Agent en WeCom

> 💡 **Requisitos previos**
>
> - Un teléfono con WeCom instalado
>
> - Configuración completa de [modelo](./model.md) (o utilice los 100 créditos de prueba incluidos en el plan Launch)
>

---

## Pasos

### 1. Iniciar sesión en la consola

Inicie sesión en LightVela, haga clic en "Mi Hermes" en la esquina superior derecha para entrar a la consola y busque el botón "Canales".

### 2. Seleccione el canal de WeCom

Busque el módulo de WeCom y haga clic en "+ Conectar".

### 3. Haga clic en "Autorizar acceso"

Un código QR aparece en la página.

![](../images/wecom1-en.webp)

> ⚠️ **Vencimiento del código QR**
>
> El código QR expira después de unos minutos. Si expira, cierre el diálogo y haga clic nuevamente en "Autorizar acceso" para generar un nuevo código QR.

### 4. Escanee con WeCom en su teléfono

1. Abra WeCom en su teléfono
2. Toque "+" en la esquina superior derecha → "Escanear"
3. Escanee el código QR en la pantalla de su computadora

![](../images/wecom2.webp)

4. Siga las indicaciones en su teléfono para completar la autorización

![](../images/wecom3.webp)

![](../images/wecom4.webp)

### 5. Chatee con el bot creado

Después de un escaneo exitoso:

- El diálogo se cierra automáticamente y se redirige a la página del bot creado
- WeCom agrega automáticamente el bot a sus contactos


Abra la ventana de chat del bot y envíe un mensaje de prueba:

```
Hello
```

Recibirá una respuesta de Hermes Agent en segundos.

![](../images/wecom5-en.webp)

---

## Estado de éxito

- Aparece una entrada de "WeCom" en la lista de "Canales conectados" de la consola
- El bot puede encontrarse en sus contactos de WeCom
- Enviar un mensaje recibe una respuesta de Hermes Agent

---

## Tipos de mensajes soportados

Después de la integración, el bot de WeCom soporta más que mensajes básicos de texto. La lista completa:

| Bot de WeCom — tipos de mensajes soportados | Soportado |
| --- | --- |
| Recibir mensajes de texto | ✅ Sí |
| Recibir imágenes / video | ✅ Sí |
| Recibir archivos | ✅ Sí |
| Recibir mensajes de voz | ✅ Sí |
| Responder con mensajes de texto | ✅ Sí |
| Responder con imágenes / video | ✅ Sí |
| Responder con archivos | ✅ Sí |
| Enviar mensajes proactivamente (por ejemplo, recordatorios programados) | ✅ Sí |

> ℹ️ **La capacidad real depende del modelo**
>
> La tabla de arriba solo refleja lo que el bot de WeCom puede recibir y responder a nivel de canal. Si tareas como el procesamiento de imágenes/archivos funcionan realmente depende de si el LLM subyacente conectado a Hermes Agent soporta esas capacidades.

---

## Preguntas frecuentes

| Síntoma | Causa posible | Resolución |
| --- | --- | --- |
| WeCom muestra "Código QR inválido" después de escanear | El código QR ha expirado | Cierre el diálogo y haga clic nuevamente en "Autorizar acceso" |
| No hay respuesta en el escritorio después de escanear | Retraso de red o autorización no completada aún | Actualice la página de la consola para confirmar el estado; si no está conectado, intente de nuevo |
| No se encuentra el contacto del bot en WeCom | Los mensajes se colapsan bajo "Notificaciones de servicio" | Busque "LightVela" o el nombre de su Hermes Agent desde la parte superior de WeCom |
| No hay respuesta después de enviar un mensaje | Modelo no configurado o créditos de prueba agotados | Verifique el estado de "Modelo actual" en la tarjeta "1. Modelo" |
| Cómo desconectar | — | Elimine la entrada de la lista de "Canales conectados" |
| ¿Puede una cuenta de WeCom única conectarse a múltiples instancias de Hermes Agent | El plan Launch limita a 1 Hermes Agent | No aplica |

---

## Notas del canal

- **Tipos de mensajes**: Texto, imágenes, video, archivos, voz y más — vea "Tipos de mensajes soportados" de arriba
- **Soporte para chat en grupo**: El chat en grupo no está soportado por ahora; solo funcionan conversaciones 1 a 1
- **Pérdida de conexión**: Los periodos largos de inactividad suelen significar que la autorización fue revocada — re-autorice desde la consola

---

## Próximos pasos

- [Configurar canal - Lark](./channel-feishu.md) — Escenarios de oficina con texto rico y chat en grupo
- [Configurar Skills](./skill.md) — Extender las capacidades de Hermes Agent
