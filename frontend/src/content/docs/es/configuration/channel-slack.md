# Configurar canal - Slack

## Resumen

**El canal de Slack se conecta con un token de bot y un token de aplicación, lo que resulta ideal para integrar a Hermes Agent en canales de equipo, mensajes directos y notificaciones de tareas automatizadas: cree una aplicación en el consol de gestión de aplicaciones de Slack, configure sus permisos, obtenga ambos tokens y péguelos en la sección de Canales del consol de LightVela. Necesita un espacio de trabajo de Slack donde pueda instalar aplicaciones y un modelo configurado (o simplemente los créditos mensuales del modelo incluidos en su plan). Ambos tokens son credenciales sensibles — nunca compártalos públicamente. Una vez conectados, el Agent en Slack comparte la misma personalidad y memoria a largo plazo que sus otros canales.**

---

Slack utiliza un Token de Bot y un Token de Aplicación para conectar Hermes Agent a los canales de equipo, mensajes directos y notificaciones de tareas automatizadas.

## Esta página cubre

- Crear una aplicación de Slack y configurar el modo Socket, permisos y eventos

- Vincular el Token de Bot de Slack y el Token de Aplicación en LightVela

- Chatear con Hermes Agent a través de canales de Slack y mensajes directos

> 💡 **Antes de comenzar**
>
> - Tiene un Hermes Agent con un modelo configurado y funcional en [Configurar modelos](./model.md)
>
> - Tiene un espacio de trabajo de Slack y permiso para crear e instalar aplicaciones
>
> - Si la instalación de la aplicación requiere aprobación del administrador, contacte al administrador de su espacio de trabajo
>
> - Prepare un lugar seguro para almacenar temporalmente ambos tokens
>
> Los Tokens de Bot y los Tokens de Aplicación son credenciales sensibles. Si un token se expone, revóquelo en Slack y genere uno de reemplazo.

---

## Pasos

### 1. Abrir la configuración del canal de Slack en LightVela

Inicie sesión en el sitio internacional de LightVela, abra **Mi Hermes → Canal**, encuentre la tarjeta **Slack** y haga clic en **+ Conectar**. Devolverá dos credenciales:

- **Token de Bot de Slack**: comienza con `xoxb-`.
- **Token de Aplicación de Slack**: comienza con `xapp-`.

### 2. Crear una aplicación de Slack

1. Abra [Slack API Apps](https://api.slack.com/apps) e inicie sesión.
2. Haga clic en **Crear nueva aplicación**.

![Crear una nueva aplicación desde Slack API Apps](../images/slack-create-app.png)

3. Seleccione **Desde cero**.

![Seleccionar Desde cero para crear la aplicación de Slack](../images/slack-create-from-scratch.png)

4. Introduzca un nombre de aplicación como `Hermes Agent`.
5. Seleccione el espacio de trabajo donde debe ejecutarse Hermes Agent, luego haga clic en **Crear aplicación**.

![Nombre la aplicación de Slack y seleccione un espacio de trabajo](../images/slack-select-workspace.png)

Si el espacio de trabajo falta, verifique que la cuenta de Slack actual pertenece a él y puede crear aplicaciones.

### 3. Crear el Token de Aplicación

El Token de Aplicación establece la conexión WebSocket en modo Socket. Debe incluir el alcance `connections:write`.

1. En la barra lateral de la aplicación de Slack, abra **Configuración → Información básica**.

![Abrir Información básica en la aplicación de Slack](../images/slack-basic-information.png)

2. Desplácese hasta **Tokens de nivel de aplicación** y haga clic en **Generar token y alcances**.

![Generar un token de nivel de aplicación](../images/slack-generate-app-token.png)

3. Introduzca un nombre de token reconocible, como `HermesSocket`.
4. Haga clic en **Agregar alcance**.

![Agregar un alcance al Token de Aplicación](../images/slack-add-connection-scope.png)

5. Busque y seleccione `connections:write`.

![Seleccionar el alcance de escritura de conexiones](../images/slack-select-connections-write.png)

6. Confirme que el alcance se lista, luego haga clic en **Generar**.

![Generar el Token de Aplicación con escritura de conexiones](../images/slack-generate-token.png)

7. Copie el token generado `xapp-...` y guárdelo de forma segura. Haga clic en **Listo** después de copiarlo.

![Copiar el Token de Aplicación de Slack](../images/slack-copy-app-token.png)

No pegue el Token de Aplicación en el campo de Token de Bot. Un Secreto de Cliente o Secreto de Firma no es un reemplazo para este token.

### 4. Configurar modo Socket, permisos y eventos

#### 4.1 Habilitar modo Socket

1. Abra **Configuración → Modo Socket**.
2. Active **Habilitar modo Socket**.

![Habilitar modo Socket de Slack](../images/slack-enable-socket-mode.png)

El modo Socket envía eventos de Slack a Hermes Agent a través de WebSocket. Esta configuración no requiere una URL de solicitud de suscripciones de eventos ni una URL de redirección OAuth.

#### 4.2 Agregar alcances de Token de Bot

1. Abra **Características → OAuth y permisos**.
2. Desplácese hasta **Alcances → Alcances de Token de Bot**.
3. Haga clic en **Agregar un alcance OAuth**.

![Agregar un alcance de bot en OAuth y permisos](../images/slack-add-oauth-scope.png)

Agregue alcances para los modos de interacción que necesite:

| Alcance | Requerido para | Propósito |
|---|---|---|
| `app_mentions:read` | Uso en canales | Recibir mensajes que mencionen al bot |
| `channels:read` | Canales públicos | Leer información básica de canales públicos |
| `channels:history` | Canales públicos | Leer mensajes en canales públicos a los que el bot se ha unido |
| `chat:write` | Todas las respuestas | Enviar mensajes como el bot |
| `im:read` | Mensajes directos | Leer información de conversaciones de mensajes directos |
| `im:history` | Mensajes directos | Leer mensajes directos enviados al bot |
| `im:write` | Mensajes directos | Abrir o gestionar conversaciones de mensajes directos |
| `groups:read` | Canales privados opcionales | Leer información de canales privados |
| `groups:history` | Canales privados opcionales | Leer mensajes en canales privados a los que el bot se ha unido |

![Revisar los alcances de Token de Bot de Slack](../images/slack-bot-token-scopes.png)

Solo agregue los dos alcances `groups:*` cuando se requiera acceso a canales privados. La aplicación aún debe ser invitada a cada canal objetivo.

#### 4.3 Habilitar mensajes directos en la página principal de la aplicación

Si los usuarios deben poder comunicarse directamente con Hermes Agent:

1. Abra **Características → Página principal de la aplicación**.
2. Desplácese hasta **Mostrar pestañas**.
3. Active **Pestaña de mensajes**.
4. Active la opción que permite a los usuarios enviar mensajes desde la pestaña de mensajes.

Si solo utiliza menciones en canales, puede omitir esta sección y los alcances `im:*` y el evento `message.im`.

#### 4.4 Suscribirse a eventos del bot

1. Abra **Características → Suscripciones de eventos**.
2. Active **Habilitar eventos**.
3. Bajo **Suscribirse a eventos del bot**, haga clic en **Agregar evento de usuario de bot**.
4. Agregue `app_mention` para menciones en canales.
5. Agregue `message.im` si se habilitan mensajes directos.
6. Haga clic en **Guardar cambios**.

![Configurar suscripciones de eventos de bot de Slack](../images/slack-event-subscriptions.png)

> Si cambia alcances o eventos después de la instalación, vuelva a **OAuth y permisos** y haga clic en **Reinstalar en espacio de trabajo**. Las nuevas permisos no surten efecto hasta que la aplicación se reinstale.

### 5. Instalar la aplicación y copiar el Token de Bot

1. Vuelva a **Características → OAuth y permisos**.
2. Haga clic en **Instalar en espacio de trabajo**. Si la aplicación ya está instalada, haga clic en **Reinstalar en espacio de trabajo**.

![Instalar la aplicación de Slack en el espacio de trabajo](../images/slack-install-workspace.png)

3. Revise los permisos solicitados y haga clic en **Permitir**.

![Autorizar los permisos de la aplicación de Slack](../images/slack-authorize-workspace.png)

4. Después de que Slack devuelva a **OAuth y permisos**, encuentre **Tokens OAuth para su espacio de trabajo**.
5. Copie el **Token OAuth de Usuario de Bot** que comienza con `xoxb-`.

![Copiar el Token OAuth de Usuario de Bot de Slack](../images/slack-copy-bot-token.png)

No utilice un Secreto de Firma, Secreto de Cliente, Token de Verificación o un Token OAuth de Usuario `xoxp-...`. LightVela requiere un Token de Aplicación `xapp-...` y un Token de Bot `xoxb-...`.

### 6. Vincular Slack en LightVela

1. Vuelva a **Mi Hermes → Canal → Slack**.
2. Pegue el token `xoxb-...` en **Token de Bot de Slack**.
3. Pegue el token `xapp-...` en **Token de Aplicación de Slack**.
4. Confirme que los tokens estén en los campos correctos, luego envíe la conexión.
5. Espere hasta que la tarjeta de Slack muestre como conectada.

### 7. Probar Hermes Agent en Slack

#### 7.1 Probar una mención en canal

1. Abra el canal de Slack donde desea usar Hermes Agent.
2. Invite la aplicación:

```text
/invite @Hermes Agent
```

3. Envíe un mensaje que mencione al bot:

```text
@Hermes Agent Summarize the key points discussed in this channel today.
```

El bot solo recibe mensajes de canal después de haberse unido a ese canal.

#### 7.2 Probar un mensaje directo

1. Abra la nueva aplicación desde la sección **Aplicaciones** en Slack.
2. Seleccione la pestaña **Mensajes**.
3. Envíe un mensaje corto como `Hola`.

![Probar un mensaje directo en la página principal de la aplicación de Slack](../images/slack-direct-message-test.png)

---

## Estado de éxito

La configuración está completa cuando todos los controles aplicables pasan:

- La tarjeta de Slack en LightVela muestra como conectada.
- La aplicación de Slack está instalada en el espacio de trabajo objetivo.
- Hermes Agent responde a una mención en un canal al que la aplicación se ha unido.
- Cuando se habilitan los permisos de Página principal de la aplicación y IM, Hermes Agent responde a un mensaje directo.

---

## Tipos de mensajes soportados

Después de conectar Slack, el canal soporta estos escenarios de mensajería:

| Tipo de mensaje de Slack | Soportado |
|---|---|
| Recibir menciones de texto en canales | ✅ Soportado |
| Recibir texto de mensaje directo en Página principal de la aplicación | ✅ Soportado |
| Responder con texto en canales y mensajes directos | ✅ Soportado |
| Enviar mensajes proactivos, como notificaciones de tareas automatizadas | ✅ Soportado |

> ℹ️ **El manejo de tareas real depende del modelo**
>
> Esta tabla describe el soporte de mensajería a nivel de canal de Slack. La resumición, traducción y otras tareas aún dependen del modelo configurado y las Skills instaladas.

---

## Preguntas frecuentes

| Problema | Posible causa | Resolución |
|---|---|---|
| Token de Aplicación rechazado | Tipo de token incorrecto o falta de `connections:write` | Generar un nuevo token `xapp-...` bajo **Información básica → Tokens de nivel de aplicación** |
| Token de Bot rechazado | Se copió un Token OAuth de Usuario u otro credencial | Copiar el Token OAuth de Usuario de Bot `xoxb-...` desde **OAuth y permisos** |
| Suscripciones de eventos piden una URL de solicitud | Modo Socket deshabilitado | Active **Configuración → Modo Socket**, luego vuelva a Suscripciones de eventos |
| Menciones en canales no se reciben | La aplicación no está en el canal, faltan alcances o falta `app_mention` | Invite la aplicación, agregue alcances de canal y `app_mention`, luego reinstale la aplicación |
| Mensajes directos no se reciben | Pestaña de mensajes deshabilitada, faltan alcances IM o falta `message.im` | Habilite la Pestaña de mensajes, agregue `im:*` y `message.im`, luego reinstale la aplicación |
| Nuevos permisos no funcionan | La aplicación no se reinstaló después de un cambio | Haga clic en **Reinstalar en espacio de trabajo** bajo **OAuth y permisos** |
| El canal está conectado pero no hay respuesta | Modelo no disponible, créditos insuficientes o problema de estado del Agent | Revise [Configurar modelos](./model.md), estado de instancia y créditos disponibles |

---

## Próximos pasos

- [Configurar canal - Telegram](./channel-telegram.md) — Conversaciones personales y notificaciones de grupo

- [Configurar canal - WhatsApp](./channel-whatsapp.md) — Comunicación de usuarios internacionales y servicio al cliente

- [Configurar canal - Discord](./channel-discord.md) — Operaciones comunitarias y comunidades de desarrolladores

- [Configurar tareas programadas](./automation.md) — Enviar recordatorios programados y resultados de tareas a Slack

- [Configurar Skills](./skill.md) — Extender las capacidades de Hermes Agent
