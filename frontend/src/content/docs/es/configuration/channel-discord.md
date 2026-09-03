# Configurar canal - Discord

## Resumen

**El canal de Discord se conecta mediante autorización de bot, lo cual es adecuado para integrar a Hermes Agent en un servidor de Discord para responder preguntas, asistir o impulsar la interacción comunitaria: cree una aplicación y un bot en el portal de desarrolladores de Discord, obtenga las credenciales, pegue estas en la sección de Canales de la consola de LightVela, e invite el bot a su servidor objetivo. Necesita un servidor de Discord donde tenga permisos de administrador y un modelo configurado (o simplemente los créditos mensuales del modelo incluidos en su plan). Una vez conectado, el Agent en Discord comparte la misma personalidad y memoria a largo plazo que sus otros canales.**

---

El canal de Discord utiliza el acceso de autorización de Bot y es adecuado para conectar Hermes Agent a un servidor de Discord, proporcionando capacidades de Q&A, asistente o interacción comunitaria en los canales.

## Esta página cubre

- Abrir un enlace de invitación en Discord y completar la autorización
- Chatear con Hermes Agent en un servidor o canal de Discord

> 💡 **Requisitos previos**
>
> - Una cuenta de Discord que pueda iniciar sesión
>
> - Un servidor de Discord donde pueda agregar bots
>
> - Completar la [configuración del modelo](./model.md) (o utilizar los 100 créditos de prueba incluidos en el plan Launch)
>

---

## Pasos

### 1. Ingresar a la consola

Inicie sesión en LightVela, haga clic en "Mi Hermes" en la esquina superior derecha para ingresar a la consola, y busque el botón "Canales".

### 2. Seleccionar el canal de Discord

Busque la tarjeta de Discord y haga clic en "+ Conectar".

### 3. Abrir Discord y ir al Portal de Desarrolladores

Elija el servidor al que desea agregar el bot, luego vaya al [Portal de Desarrolladores](https://discord.com/developers/home):

1. Haga clic en Aplicaciones

![](../images/discord-1-global.webp)

2. Haga clic en Nueva Aplicación en la esquina superior derecha

3. Asigne un nombre a su Aplicación

4. Añada un bot a su aplicación y genere un token de bot. El token se utiliza para autenticar la conexión entre Hermes Agent y su servidor de Discord.

![](../images/discord-2-global.webp)

5. Pegue el token en la tarjeta de Discord.

![](../images/discord-3-global-en.webp)

### 4. Ir a la página de Bot en el Portal de Desarrolladores

En la página de Bot, desplace hacia abajo hasta Privileged Gateway Intents y active:

- **Message Content Intent**: obligatorio, utilizado para leer el contenido del mensaje
- **Server Members Intent**: recomendado, utilizado para la lista de roles y para coincidir nombres con IDs
- **Presence Intent**: opcional, solo utilizado para actualizaciones de estado

![](../images/discord-4-global.webp)

Después de activarlos, haga clic en Guardar Cambios en la parte inferior.

### 5. Ir a la página de OAuth2 en el Portal de Desarrolladores

Configure los permisos del bot: haga clic en OAuth2 en la barra lateral izquierda, luego seleccione OAuth2 URL Generator. Configure los Alcances primero; siguiendo el principio de menor privilegio, prefiera `bot` y `applications.commands`.

![](../images/discord-5-global.webp)

Continúe desplazándose hacia abajo para configurar los Permisos del Bot, y seleccione:

- Ver Canales
- Enviar Mensajes
- Leer Historial de Mensajes
- Insertar Enlaces
- Adjuntar Archivos
- Agregar Reacciones (opcional)

![](../images/discord-6-global.webp)

### 6. Copiar y abrir el enlace de invitación

Copie el enlace de invitación generado, ábralo en su navegador e invite el bot a su servidor de Discord (se requieren permisos de administrador de servidor). Después de hacer clic en Continuar y autorizar, el bot será invitado al servidor.

![](../images/discord-7-global.webp)

### 7. Chatear con el nuevo bot en Discord

Ahora puede comenzar a interactuar con el bot. Abra el chat con el bot y envíe un mensaje de prueba:

```
Hi
```

![](../images/discord-chat-global.webp)

Debería recibir una respuesta de Hermes Agent en unos pocos segundos.

---

## Estado de éxito

- La lista de "Canales conectados" en la consola contiene "Discord"
- El bot correspondiente puede encontrarse en los contactos de Discord
- Hermes Agent responde después de que envíe un mensaje

---

## Tipos de mensajes soportados

Después de que el acceso sea exitoso, el bot de Discord puede recibir y responder mensajes de texto básicos y soporta más tipos de mensajes como sigue:

| Tipo de mensaje soportado por el bot de Discord | Soportado |
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
> La tabla de arriba solo indica los tipos de mensajes soportados por el bot de Discord en la capa de canal. Si las imágenes, archivos y otras tareas pueden procesarse realmente también depende de si el modelo de lenguaje grande conectado a Hermes Agent tiene las capacidades correspondientes.

---

## Preguntas frecuentes

| Problema | Posible causa | Solución |
|---|---|---|
| No puedo crear un Bot de Discord | No ingresó al Portal de Desarrolladores de Discord, o el flujo de creación de aplicación no se completó | Ingrese al Portal de Desarrolladores de Discord, cree una Aplicación, luego añada un Bot |
| No puedo encontrar el Token del Bot | El token no se generó o no se copió completamente | En la página de Bot, haga clic en Reiniciar Token / Copiar Token, luego pegue el token completo en el campo de token |
| El token muestra como inválido después de pegar | El token es incompleto o contiene espacios extra / saltos de línea | Vuelva a copiar el Bot Token completo y confirme que no haya espacios extra |
| No puedo invitar el bot a un servidor | La URL de OAuth2 está mal configurada, o su cuenta carece de permisos de administrador de servidor | En el Generador de URL de OAuth2, seleccione el alcance `bot`, y confirme que tiene permisos de administrador en el servidor |
| El bot no aparece en el servidor después de la invitación | La invitación no se completó, o el bot no está en línea | Vuelva a abrir el enlace de invitación para confirmar que la autorización se completó; refresque la lista de miembros del servidor de Discord |
| No hay respuesta después de enviar un mensaje | El modelo no está configurado, los créditos de prueba se agotaron, o el canal de Discord no se conectó correctamente | Verifique el estado de "Modelo actual" en la tarjeta "1. Modelo" y confirme que el canal de Discord muestre como conectado |
| El bot no puede leer el contenido del mensaje | El Message Content Intent no está habilitado | Habilite Message Content Intent en la configuración de Bot del Portal de Desarrolladores de Discord |
| El bot no tiene permisos para responder en un canal | Permisos de canal insuficientes | Confirme que el bot tenga permisos de Ver Canales, Enviar Mensajes, Leer Historial de Mensajes y otros permisos necesarios |
| El bot no puede recibir mensajes directos | Restricción de permiso de DM o configuración de privacidad del usuario | Confirme que el bot permite DMs, y verifique la configuración de privacidad de Discord del usuario |
| ¿Cómo desconectar? | — | Elimine el registro de Discord correspondiente en la lista de "Canales conectados" |
| ¿Puede el mismo Bot de Discord conectarse a múltiples instancias de Hermes Agent? | No se recomienda; un Token de Bot debe estar vinculado a una instancia de Hermes Agent | Si necesita múltiples instancias de Hermes Agent, cree Bots de Discord separados |

---

## Notas del canal

- **Tipos de mensaje**: Soporta texto, imágenes, videos, archivos, mensajes de voz y más. Vea "Tipos de mensajes soportados" de arriba

- **Soporte para chats grupales**: Los chats grupales no se soportan actualmente; solo se soportan conversaciones 1 a 1

- **Interrupción de conexión**: Los largos periodos de sin respuesta pueden indicar que la autorización fue revocada. Vuelva a la consola y autorice el acceso nuevamente

---

## Próximos pasos

- [Configurar canal - Slack](./channel-slack.md) — Colaboración de equipo, notificaciones de espacio de trabajo y flujos de canal

- [Configurar canal - QQ](./channel-qq.md) — Bot creado manualmente, integrado vía AppID/AppSecret

- [Configurar canal - WeCom](./channel-wecom.md) — Colaboración interna empresarial y escenarios de oficina

- [Configurar canal - Lark](./channel-feishu.md) — Escenarios de oficina con texto rico y chat grupal

- [Configurar Skills](./skill.md) — Extender las capacidades de Hermes Agent
