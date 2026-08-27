# Inicio rápido

## Resumen

**Poner en marcha su primera conversación con LightVela toma aproximadamente 5 minutos: inicie sesión en LightVela, active un plan, permita que la plataforma cree su instancia de Hermes Agent, configure un modelo (o utilice simplemente los créditos de modelo mensuales incluidos con su plan), conecte un canal de mensajería, luego envíe un mensaje y reciba una respuesta. Todo ocurre en el navegador — no necesita comprar servidores ni desplegar nada localmente. La ruta más rápida es utilizar los créditos de su plan junto con WeChat, que se conecta escaneando un código QR, y agregar más tarde su propia clave de API de modelo y otros canales.**

---

Este tutorial guía a través del proceso completo desde el inicio de sesión hasta recibir una respuesta de Hermes en WeChat. Toma aproximadamente 5 minutos.

## ¿Qué cubre esta página?

- Iniciar sesión en LightVela

- Activar el plan Launch y crear una instancia de Hermes

- Conectar canales de Telegram / WhatsApp / Discord / Slack / WeChat

- Enviar un mensaje en WeChat y recibir una respuesta

> 💡 **Requisitos previos**
>
> - Una cuenta de Google o GitHub
>
> El plan Launch incluye 100 créditos de prueba, por lo que puede comenzar a chatear sin preparar previamente una clave de API de modelo de gran lenguaje.

---

## 1. Iniciar sesión en LightVela

Visite [lightvela.ai](https://lightvela.ai) y haga clic en "Iniciar sesión" en la esquina superior derecha. En el cuadro de diálogo de inicio de sesión, seleccione Google o GitHub, acepte los acuerdos y complete la autorización.

![](./images/2-1.webp)

---

## 2. Activar el plan Launch

Vuelva a la página de inicio, haga clic en "Crear ahora" para entrar a la página del plan, seleccione "Launch" y haga clic en "Activar ahora".

![](./images/2-2.webp)

> ⚠️ **Launch tiene una prueba gratuita de 14 días para nuevos usuarios después de que comience la facturación**
>
> Los planes de LightVela entrarán en beta pública y comenzarán la facturación el 18 de agosto de 2026 (Hora de Singapur). Después de que comience la facturación, los nuevos usuarios pueden probar Launch gratis durante 14 días. Consulte [Anuncio de la versión pagada de LightVela](./announcements/public-beta.md).

Después de que el activación tenga éxito, la barra de navegación superior muestra "Mi Hermes" y la página se redirige automáticamente al consola. Para detalles del plan, consulte [¿Qué es LightVela - Sobre los planes](./01-overview.md#about-plans).

---

## 3. Crear una instancia de Hermes

Cuando ingrese al consola, la página muestra un estado vacío porque aún no se ha creado ningún Hermes.

![](./images/20260424-113103-70fi.webp)

Haga clic en "Crear ahora". La página muestra la animación de transición de creación "Preparando café para Hermes y despertando su cerebro...". Espere aproximadamente una docena de segundos.

![](./images/20260424-113120-qvlx.webp)

Después de que la creación se complete, la parte superior del consola muestra la tarjeta de información básica de Hermes, el estado es ● En ejecución, y aparecen los tres botones de configuración para modelos, canales y Skills debajo.

![](./images/2-5.webp)

> 💡 **Renombrar Hermes**
>
> Haga clic en el nombre o en el icono de lápiz al lado, ingrese un nuevo nombre y presione Enter para guardar. El nombre solo se utiliza como identificador y no afecta el comportamiento del Agent.

---

## 4. Conectar el canal de WeChat

Ingrese el botón "Canal", seleccione "WeChat" de la lista desplegable, haga clic en "Autorizar acceso" y aparecerá un código QR.

![](./images/2-6.webp)

Utilice "Escanear" en WeChat en su teléfono para escanear el código QR, luego siga las indicaciones en su teléfono para completar la autorización. Después de que la autorización tenga éxito, el diálogo se cierra automáticamente, aparece un registro de "WeChat" en el área de "Canales conectados" y se agrega automáticamente una cuenta de bot a sus contactos de WeChat.

> ⚠️ **Después de escanear**
>
> Después de escanear, WeChat le solicitará agregar una cuenta de bot. Después de agregarla, chatear con esa cuenta es equivalente a chatear con Hermes.

Para más detalles, consulte [Configurar Canal - WeChat](./configuration/channel-wechat.md).

---

## 5. Enviar su primer mensaje

Encuentre la cuenta de bot agregada en WeChat y envíe un mensaje de prueba:

```
Hi
```

![](./images/2-7.webp)

Debería recibir una respuesta de Hermes en unos pocos segundos. Hermes ahora puede chatear a través de WeChat.

> 💡 **Facturación de mensajes**
>
> Por defecto, las llamadas de modelo utilizan los 100 créditos de prueba incluidos en el plan Launch, por lo que no se requiere configuración adicional. Después de que se agoten los créditos, configure su propia clave de API en la tarjeta "1. Modelo". Consulte [Configurar Modelos](./configuration/model.md) para el proceso completo.

---

## Avanzado: configure su propio modelo (opcional)

Si necesita utilizar un modelo de un proveedor específico, o continuar utilizando Hermes después de que se agoten los créditos, abra la tarjeta "1. Modelos" en el consola, seleccione una fuente y un modelo, ingrese la clave de API y haga clic en "Agregar como predeterminado". Consulte [Configurar Modelos](./configuration/model.md) para el proceso completo.

---

## Preguntas frecuentes

| Problema | Posible causa | Solución |
|---|---|---|
| No se puede activar el plan Launch | La oferta actual o el flujo de pago no está disponible | Consulte la [página de Suscripción](/subscribe) y siga las actualizaciones oficiales |
| La creación de Hermes permanece en la página de transición durante mucho tiempo | La inicialización en la nube es lenta o la red es inestable | Refresque la página; si no hay respuesta después de 1 minuto, haga clic nuevamente en "+ Crear Hermes" |
| No hay respuesta en el consola después de escanear el código QR de WeChat | El código QR ha expirado | Cierre el diálogo y haga clic nuevamente en "Autorizar acceso" para generar un nuevo código QR |
| No hay respuesta después de enviar un mensaje | Se han agotado los créditos de prueba o el canal no está conectado | Verifique el estado de "Canales conectados"; configure su propia clave de API después de que se agoten los créditos |
| El contacto del bot desaparece en WeChat | La autorización fue revocada o el acceso se desconectó | Vuelva al consola y autorice el acceso nuevamente en la tarjeta "Canal" |

---

## Próximos pasos

- [Conceptos fundamentales](./04-core-concepts.md) — Comprender los cuatro conceptos fundamentales: Hermes, modelos, canales y Skills

- [Resumen de configuración](./05-configuration.md) — Estructura general del consola

- [Configurar Skills](./configuration/skill.md) — Extender Hermes a través de SkillHub
