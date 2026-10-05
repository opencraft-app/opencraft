# Inicio rápido

## Resumen

**Para iniciar la primera conversación en LightVela, inicie sesión y active un plan, espere a que el Bot esté listo y envíe un mensaje desde Chat en My Agent. El Chat web no requiere un canal de mensajería; si hay créditos de modelo disponibles, tampoco necesita una clave de API propia. Si desea usar el mismo Bot en WeChat, siga después los pasos de conexión mediante código QR.**

---

Este tutorial comienza con el Chat web y después explica cómo conectar WeChat si lo desea. Reserve tiempo adicional para activar el plan y preparar el Bot.

## ¿Qué cubre esta página?

- Iniciar sesión en LightVela

- Activar el plan Launch y crear una instancia de Hermes

- Enviar el primer mensaje en el Chat web

- Conectar WeChat si lo desea

- Enviar un mensaje en WeChat y recibir una respuesta

> 💡 **Requisitos previos**
>
> - Una cuenta de Google o GitHub
>
> El plan Launch incluye 100 créditos de prueba, por lo que puede comenzar a chatear sin preparar previamente una clave de API de modelo de gran lenguaje.

---

## 1. Iniciar sesión en LightVela

Visite [lightvela.ai](https://lightvela.ai) y haga clic en "Iniciar sesión" en la esquina superior derecha. En el cuadro de diálogo de inicio de sesión, seleccione Google o GitHub, acepte los acuerdos y complete la autorización.

![](../images/2-1.webp)

---

## 2. Activar el plan Launch

Abre la [página de suscripción](/subscribe), elige la opción **Launch de 100 créditos** de la serie Launch y sigue la tarjeta hasta completar la activación. Comprueba el precio y la oferta de primer pedido antes de confirmar.


> ⚠️ **Ofertas para nuevos usuarios**
>
> Los nuevos usuarios que cumplan los requisitos pueden probar Launch gratis durante 1 mes. Consulta la [página de suscripción](/subscribe/) para conocer las condiciones y la disponibilidad actuales.


---

## 3. Abrir Hermes Agent

Después de activar el plan, abre la [consola de Agent](/agents/overview/). LightVela prepara la instancia en la nube. Si la consola solicita crear el Agent, sigue las instrucciones y espera al estado **Running**. La barra lateral muestra **Channels**, **Models**, **Skills** y **Scheduled Tasks**. Puedes usar los créditos del plan sin introducir tu propia clave de API.

---

## 4. Iniciar una conversación en el Chat web

Cuando el Bot esté listo, abra Chat en la sección de uso diario, cree una conversación nueva y envíe «Hola». Una respuesta confirma que el Chat web funciona; consulte [Chat](./configuration/agent-chat.md) para gestionar conversaciones.

## 5. Conectar WeChat si lo desea

Abre **Channels** en la barra lateral de Agent. En la tarjeta **WeChat**, selecciona **+ Connect** y sigue las instrucciones del código QR. Escanéalo con WeChat en el teléfono y termina la autorización. Confirma que WeChat aparece como conectado antes de enviar un mensaje. Consulta la [guía de WeChat](./configuration/channel-wechat.md) si caduca el código o falla la conexión.

---

## 6. Enviar un mensaje en WeChat

Encuentre la cuenta de bot agregada en WeChat y envíe un mensaje de prueba:

```
Hi
```

![](../images/2-7.webp)

Debería recibir una respuesta de Hermes en unos pocos segundos. Hermes ahora puede chatear a través de WeChat.

> 💡 **Facturación de mensajes**
>
> Las llamadas al modelo usan por defecto los 100 créditos de la opción Launch. Si se agotan, puedes comprar un [paquete de créditos](./credits.md) admisible o añadir tu propia clave de API en **Models**.

---

## Avanzado: configure su propio modelo (opcional)

Si necesitas un proveedor específico, abre **Models** en la barra lateral de Agent, elige proveedor y modelo, añade la clave de API y establece el modelo principal. Consulta [Configurar modelos](./configuration/model.md).

---

## Preguntas frecuentes

| Problema | Qué revisar | Acción |
|---|---|---|
| No se puede activar Launch | Disponibilidad, elegibilidad y estado del pago | Revisa la [página de suscripción](/subscribe) y el mensaje final; evita repetir un pedido completado. |
| La preparación del Agent tarda demasiado | Si la consola sigue aprovisionando o muestra un error | Actualiza una vez la vista general del Agent; si no cambia, consulta [Diagnostics](./configuration/diagnostics.md) o contacta con soporte. |
| Caduca el código QR de WeChat | Si terminó la autorización en el teléfono | Vuelve a **Channels** e inicia una conexión nueva. |
| No llega respuesta | Conexión del canal, estado del Agent y créditos | Revisa **Channels** y **Diagnostics**. Si no quedan créditos, consulta las [opciones de recarga](./credits.md). |
---

## Próximos pasos

- [Conceptos fundamentales](./04-core-concepts.md) — Comprender los cinco conceptos fundamentales: Hermes Agent, Bots, modelos, canales y Skills

- [Resumen de configuración](./05-configuration.md) — Estructura general del consola

- [Configurar Skills](./configuration/skill.md) — Instalar Skills de Skills.sh o ClawHub
