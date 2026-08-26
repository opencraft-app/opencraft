# Configurar canal - Telegram

## Resumen

**El canal de Telegram se conecta con un token de bot, lo que lo convierte en una forma rápida de llevar a Hermes Agent a los mensajes directos o grupos de Telegram: cree un bot a través de BotFather en Telegram, copie su token de bot y péguelo en la sección de Canales de la consola de LightVela. Necesita una cuenta de Telegram y un modelo configurado (o simplemente los créditos mensuales del modelo incluidos en su plan). El token de bot es una credencial sensible — nunca compártala públicamente. Una vez conectado, el Agent en Telegram comparte la misma personalidad y memoria a largo plazo que sus otros canales.**

---

El canal de Telegram utiliza el acceso mediante Token de Bot y es adecuado para conectar rápidamente Hermes Agent a chats privados o grupos de Telegram.

## Esta página cubre

- Autorizar el acceso escaneando un código o abriendo un enlace en Telegram desde su teléfono
- Chatear con Hermes Agent en Telegram


> 💡 **Requisitos previos**
>
> - Un teléfono con Telegram instalado
>
> - Completar la [configuración del modelo](./model.md) (o utilizar los 100 créditos de prueba incluidos en el plan Launch)
>

---

## Pasos

### 1. Ingresar a la consola

Inicie sesión en LightVela, haga clic en "Mi Hermes" en la esquina superior derecha para ingresar a la consola y busque el botón "Canales".

### 2. Seleccionar el canal de Telegram

Busque la tarjeta de Telegram y haga clic en "+ Conectar".

### 3. Abrir Telegram

1. Abra la aplicación de Telegram en su teléfono
2. Busque @BotFather y abra el chat
<img src="../images/telegram-botfather-2-global.webp" alt="" width="360" />
3. Envíe `/start`
4. Envíe `/newbot`
5. Ingrese un nombre para su Agent: el nombre de usuario debe ser único y terminar con "bot"
6. Copie el token de la API HTTP:

![](../images/telegram-botfather-3-global.webp)

### 4. Pegar el token de la API HTTP en Telegram

Pegue el token de la API HTTP en el campo de token.

<img src="../images/telegram-botfather-4-global.webp" alt="" width="360" />

> ⚠️ **Mantenga su token seguro**
>
> Guarde el token de forma segura. Cualquier persona que obtenga el token puede tomar el control de su bot!

### 5. Chatear con el nuevo bot en Telegram

Haga clic en el enlace proporcionado por BotFather e inicie la interacción con el bot.

![](../images/telegram-botfather-5-global.webp)

Abra el chat con el bot y envíe un mensaje de prueba:

```
Hi
```

Debería recibir una respuesta de Hermes Agent en unos pocos segundos.

<img src="../images/telegram-botfather-6-global-en.webp" alt="" width="360" />

### 6. Opcional: habilitar los mensajes de grupo en BotFather

Complete los pasos 6 y 7 únicamente si quiere usar el bot en un grupo.
Los mensajes directos ya están disponibles después del paso 5.

1. Abra `@BotFather` en Telegram.
2. Envíe `/mybots`.
3. Seleccione el bot conectado a su Hermes Agent.
4. Abra "Bot Settings".
5. Seleccione "Group Privacy".
6. Elija "Turn off" o "Disable privacy mode".

### 7. Opcional: añadir y probar el bot en un grupo

1. Abra el grupo de Telegram en el que quiere usarlo.
2. Seleccione "Add Members" o la acción equivalente para gestionar integrantes.
3. Busque el bot por su nombre de usuario y añádalo al grupo.
4. Menciónelo con `@bot_username` y envíe un mensaje de prueba.

Después de desactivar Group Privacy, el bot puede recibir y responder los mensajes de grupo que lo mencionen.

---

## Estado de éxito

- La lista de "Canales conectados" en la consola contiene "Telegram"
- El bot correspondiente puede encontrarse en los contactos de Telegram
- Hermes Agent responde después de que envíe un mensaje
- Hermes Agent responde después de que mencione al bot y envíe un mensaje en un grupo al que se haya añadido


---

## Tipos de mensajes soportados

Después de que el acceso sea exitoso, el bot de Telegram puede recibir y responder mensajes de texto básicos y soporta más tipos de mensajes como sigue:

| Tipo de mensaje soportado por el bot de Telegram | Soportado |
|---|---|
| Recibir mensajes de texto | ✅ Soportado |
| Recibir imágenes y videos | ✅ Soportado |
| Recibir archivos | ✅ Soportado |
| Responder con mensajes de texto | ✅ Soportado |
| Responder con imágenes y videos | ✅ Soportado |
| Responder con archivos | ✅ Soportado |
| Enviar mensajes proactivamente (como recordatorios programados) | ✅ Soportado |

> ℹ️ **La capacidad de procesamiento real depende del modelo**
>
> La tabla de arriba solo indica los tipos de mensajes soportados por el bot de Telegram en la capa de canal. Si las imágenes, archivos y otras tareas pueden procesarse realmente también depende de si el modelo de lenguaje grande conectado a Hermes Agent tiene las capacidades correspondientes.

---

## Preguntas frecuentes

| Problema | Posible causa | Solución |
|---|---|---|
| BotFather no puede crear un bot | El nombre del bot o el nombre de usuario no cumplen los requisitos de Telegram | El nombre de visualización puede ser cualquier cosa, pero el nombre de usuario debe terminar con `bot`, por ejemplo `my_hermes_bot` |
| BotFather no devolvió un token de la API HTTP | El flujo de creación no se completó | Vuelva al chat de BotFather, ejecute `/newbot` nuevamente y siga las indicaciones para establecer el nombre y el nombre de usuario |
| El token muestra como inválido después de pegar | El token es incompleto o contiene espacios extra / saltos de línea | Vuelva a copiar el token completo de la API HTTP de BotFather y péguelo en el campo de token |
| No hay respuesta después de hacer clic en acceso | Retraso de red o autorización no completada | Actualice la consola para confirmar el estado; si el acceso no fue exitoso, intente de nuevo |
| No se puede encontrar el bot en Telegram | No hizo clic en el enlace proporcionado por BotFather o no inició el chat | Haga clic en el enlace proporcionado por BotFather, luego haga clic en Iniciar en la página del bot |
| No hay respuesta después de enviar un mensaje | El modelo no está configurado, los créditos de prueba se agotaron o el bot no se conectó correctamente | Verifique el estado de "Modelo actual" en la tarjeta "1. Modelo" y confirme que el canal de Telegram muestre como conectado |
| El bot no puede recibir mensajes de grupo | Group Privacy sigue activado, el bot no se ha añadido al grupo o el mensaje no lo menciona | En BotFather, envíe `/mybots`, seleccione el bot y abra "Bot Settings" → "Group Privacy" para desactivar el modo de privacidad. Añada el bot al grupo y envíe un mensaje de prueba con `@bot_username` |
| ¿Cómo desconectar? | — | Elimine el registro de Telegram correspondiente en la lista de "Canales conectados" |
| ¿Puede el mismo bot de Telegram conectarse a múltiples instancias de Hermes Agent? | No se recomienda; un Token de Bot debe estar vinculado a una instancia de Hermes Agent | Si necesita múltiples instancias de Hermes Agent, cree bots de Telegram separados |

---

## Notas del canal

- **Tipos de mensaje**: Soporta texto, imágenes, videos, archivos, mensajes de voz y más. Vea "Tipos de mensajes soportados" de arriba
- **Soporte para chats de grupo**: Los mensajes de grupo son compatibles después de desactivar Group Privacy en BotFather, añadir el bot al grupo e iniciar la conversación con `@bot_username`
- **Interrupción de conexión**: Los largos periodos sin respuesta pueden indicar que la autorización fue revocada. Vuelva a la consola y autorice el acceso nuevamente

---

## Próximos pasos

- [Configurar canal - WhatsApp](./channel-whatsapp.md) — Comunicación internacional de usuarios y servicio al cliente
- [Configurar canal - Discord](./channel-discord.md) — Operaciones comunitarias y comunidades de desarrolladores
- [Configurar canal - Slack](./channel-slack.md) — Colaboración de equipo, notificaciones de espacio de trabajo y flujos de canal
- [Configurar canal - QQ](./channel-qq.md) — Bot creado manualmente, integrado mediante AppID/AppSecret
- [Configurar Skills](./skill.md) — Extender las capacidades de Hermes Agent
