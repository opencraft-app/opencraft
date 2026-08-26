# Configurar canal - Lark

## Resumen

**El canal de Lark está diseñado para uso en el lugar de trabajo, soporta mensajes con formato rico y menciones al bot en chats grupales, y se conecta de la misma manera que WeChat: seleccione Lark en la sección de Canales de la consola, haga clic para autorizar y generar un código QR, luego escárelo con Lark para comenzar a hablar. Necesita Lark instalado en su teléfono (o iniciado sesión en escritorio) y un modelo configurado (o simplemente los créditos mensuales del modelo incluidos en su plan). Un Agent puede conectarse a varios canales a la vez, compartiendo la misma personalidad y memoria a largo plazo.**

---

El canal de Lark está diseñado para escenarios de oficina. Soporta mensajes con formato rico y menciones al bot en chats grupales. La integración utiliza autorización mediante código QR, similar a WeChat.

## Esta página cubre

- Generar un código QR de acceso a Lark en LightVela
- Escanear el código QR con Lark para autorizar
- Chatear con Hermes Agent en Lark

> 💡 **Requisitos previos**
>
> - Un teléfono con Lark instalado (o un Lark en escritorio ya iniciado sesión)
>
> - Completar la [configuración del modelo](./model.md) (o utilizar los 100 créditos de prueba incluidos en el plan Launch)
>

---

## Pasos

### 1. Ingresar a la consola

Inicie sesión en LightVela, haga clic en "Mi Hermes" en la esquina superior derecha para ingresar a la consola y busque el botón "Canales".

### 2. Seleccionar el canal de Lark

Haga clic en la lista desplegable y seleccione "Lark". Aparecerá la introducción del canal de Lark debajo.

### 3. Hacer clic en "Autorizar acceso"

Un código QR aparecerá en la página.

![](../images/lark1.webp)

### 4. Escanear con Lark

**En móvil:**

1. Abra Lark
2. Toque "+" en la esquina superior derecha → "Escanear"
3. Escanee el código QR en su pantalla de computadora
4. Siga las instrucciones para completar la autorización


![](../images/lark2.webp)

### 5. Buscar Hermes Agent en Lark

Después de un escaneo exitoso:

- Aparecerá una entrada de "Lark" en la lista de "Canales conectados" de la consola
- Lark agregará automáticamente el bot a sus contactos


Busque el nombre de la aplicación que creó en Lark.

![](../images/lark3.webp)

Abra la ventana de chat del bot y envíe un mensaje de prueba:

```
Hello
```

![](../images/lark4.webp)

## Estado de éxito

- Aparecerá una entrada de "Lark" en la lista de "Canales conectados" de la consola
- El bot se puede encontrar mediante la búsqueda de Lark
- Al enviar un mensaje, se recibirá una respuesta de Hermes Agent

---

## Tipos de mensajes soportados

Después de la integración, el bot de Lark soporta más que texto básico. La lista completa:

| Bot de Lark — tipos de mensajes y características soportados | Soportado |
| --- | --- |
| Recibir mensajes de texto | ✅ Sí |
| Recibir imágenes | ✅ Sí |
| Recibir archivos | ✅ Sí |
| Recibir audio / video | ✅ Sí |
| Responder con mensajes de texto | ✅ Sí |
| Responder con imágenes | ✅ Sí |
| Responder con archivos | ✅ Sí |
| Responder con audio | ✅ Sí |
| El contenido de respuesta soporta Markdown | ✅ Sí |
| Enviar mensajes proactivamente (por ejemplo, recordatorios programados) | ✅ Sí |
| Operar Lark Docs, Wiki, Drive | ✅ Sí |

> ℹ️ **La capacidad real depende del modelo**
>
> La tabla de arriba solo refleja lo que el bot de Lark puede recibir y responder a nivel de canal. Si tareas como el procesamiento de imágenes o archivos funcionan realmente depende de si el LLM subyacente conectado a Hermes Agent soporta esas capacidades.

---

## Preguntas frecuentes

| Síntoma | Causa posible | Resolución |
| --- | --- | --- |
| El escaneo muestra "Aplicación no autorizada" | El administrador del inquilino restringe aplicaciones de terceros | Pida al administrador de su inquilino que permita la aplicación, o cambie a un inquilino personal |
| El contacto del bot no se encuentra | Lark colapsa los bots por defecto | Busque el nombre de la aplicación de Hermes Agent desde la parte superior de Lark |
| ¿Cómo agregar el bot a un grupo? | — | En la configuración del grupo, "Agregar miembros", busque el bot y agréguelo |
| Código QR expirado | No se escaneó dentro del período de validez | Cierre el diálogo y haga clic nuevamente en "Autorizar acceso" |
| No hay respuesta después de enviar un mensaje | El modelo no está configurado o los créditos de prueba se agotaron | Verifique el estado de "Modelo actual" |
| Problemas de renderizado de texto enriquecido | Lark no soporta cierta sintaxis Markdown | La conversación en texto plano no se ve afectada |

---

## Notas del canal

- **Tipos de mensajes**: Texto, texto enriquecido, imágenes, archivos, audio, video y más — consulte "Tipos de mensajes soportados" de arriba
- **Soporte para chats grupales**: El bot puede agregarse a chats grupales y responderá cuando se lo mencione con @
- **Restricciones del inquilino**: Si un inquilino empresarial de Lark permite bots de terceros depende de la política del administrador del inquilino

---

## Próximos pasos

- [Configurar Skills](./skill.md) — Extender las capacidades de Hermes Agent
