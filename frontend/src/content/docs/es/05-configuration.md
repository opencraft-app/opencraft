# Visión general de la configuración

## Resumen

**La consola de Agent separa Channels, Models, Skills y Scheduled Tasks en páginas de la barra lateral. Selecciona el Bot adecuado antes de cambiar sus ajustes. Conecta un canal desde su tarjeta, elige un modelo o usa los créditos del plan y, cuando lo necesites, instala Skills de Skills.sh o ClawHub. Soul, Memory, Diagnostics, Advanced Settings y Labs aparecen en otras secciones; Cloud Storage se abre desde el menú de usuario. Cuando el Bot esté en línea y haya créditos disponibles o un modelo configurado, use Chat directamente sin conectar antes un canal.**

---

La consola de Agent organiza la configuración cotidiana en las páginas **Channels**, **Models**, **Skills** y **Scheduled Tasks** de la barra lateral. Selecciona el Bot que quieras configurar y abre la página correspondiente. Esta guía explica las entradas y la comprobación del resultado.

## Esta página cubre

- Cómo ingresar al consola

- Selector de Bots e información del Bot seleccionado

- Dónde encontrar Channels, Models, Skills y Cloud Storage

- Estado de éxito después de la configuración

- Operaciones comunes como gestionar Bots, cambiar modelos y conectar múltiples canales

---

## Ingresar al consola

Después de iniciar sesión, abre la [consola del Agent](/agents/overview/) y selecciona el Hermes Agent y el Bot que quieres configurar.


El Chat web está en la sección de uso diario; conecte un canal externo solo si desea utilizar una aplicación de mensajería.
---

## Bots e información del Bot seleccionado

La parte superior de la consola contiene las pestañas de Bot del Agent de Hermes actual. La primera pestaña es el Bot principal y cada pestaña adicional corresponde a un perfil de Bot independiente. El plan determina el límite total de Bots, incluido el principal. Durante el despliegue gradual en el sitio internacional, la entrada de creación no se muestra de forma predeterminada. Consulte [Gestionar Bots](./configuration/bots.md) para conocer los métodos de creación y las reglas de herencia.

Después de seleccionar un Agent de Hermes, se muestran sus información básica a continuación:

- Avatar

- Nombre (haga clic en el nombre o en el icono de lápiz para editar, luego presione Enter para guardar)

- Estado (● En ejecución / ● Desconocido)

- Hora de creación

- Botón de eliminar (icono de papelera a la derecha)

> ⚠️ **La eliminación es irreversible**
>
> Eliminar un Bot adicional borra permanentemente su perfil y sus datos. Eliminar el Bot principal borra todo el Agent de Hermes y los datos relacionados, y solo se permite después de eliminar los demás Bots.

---

## Configurar canales, modelos y Skills

### Channels

Abre **Channels** en la barra lateral de Agent. Hay tarjetas para Telegram, WhatsApp, Discord, Slack, WeChat, QQ, WeCom y Lark. Selecciona **+ Connect** en el canal deseado. WhatsApp, WeChat, WeCom y Lark usan códigos QR; Telegram, Discord y Slack requieren credenciales. QQ admite código QR o App ID / Secret. Consulta la [guía de WhatsApp](./configuration/channel-whatsapp.md).

### Models

Abre **Models** para ver el modelo activo o configurar un proveedor. Puedes usar los créditos del plan sin introducir tu propia clave de API y añadir un proveedor cuando lo necesites. Cada Bot usa un modelo principal a la vez y puede tener modelos alternativos configurados. Consulta [Configurar modelos](./configuration/model.md) y [Cambio de modelo](./configuration/multiple-models.md).

### Skills

Abre **Skills** para buscar Skills o explorar **Skill Packages** de [Skills.sh](https://skills.sh/) y [ClawHub](https://clawhub.ai/). Selecciona **Install** y comprueba el resultado en **Installed**. Consulta [Configurar Skills](./configuration/skill.md).

## Estado de éxito después de la configuración

Después de completar la configuración, el consola debe mostrar el siguiente estado:

- La lista de "Canales conectados" tiene al menos un registro (como "WeChat")

- "Modelo actual" es opcional; no se requiere configuración si utiliza los créditos de prueba de Launch

- "Skills instaladas" puede configurarse según sea necesario y puede estar vacío

Una vez que "Canales conectados" tenga al menos un registro, puede encontrar el bot en la plataforma de mensajería correspondiente y comenzar una conversación. Agent de Hermes generará respuestas utilizando el modelo predeterminado o los créditos de prueba de Launch.

---

## Operaciones comunes

- **Cambiar de modelo:** Abre **Models** en el Bot seleccionado y elige un modelo disponible que ya esté configurado. La memoria del Bot se conserva; consulta [Cambio de modelo](./configuration/multiple-models.md).
- **Conectar varios canales:** Abre **Channels** y usa **+ Connect** en cada tarjeta necesaria. Los canales de un mismo Bot comparten su personalidad y memoria.
- **Gestionar Bots:** Selecciona la pestaña del Bot antes de cambiar ajustes. Si está disponible la creación, sigue [Gestionar Bots](./configuration/bots.md).
- **Abrir Cloud Storage:** Entra desde el menú de usuario, no desde la barra lateral del Agent.

---

## Próximos pasos

Configuración detallada para cada módulo:

- [Gestionar Bots](./configuration/bots.md) — Crear, copiar, cambiar, renombrar y eliminar Bots

- [Configurar Modelos](./configuration/model.md) — Fuentes de modelo, adquisición de Clave de API y guía de selección

- [Configurar Canal - WeChat](./configuration/channel-wechat.md) / [Telegram](./configuration/channel-telegram.md) / [WhatsApp](./configuration/channel-whatsapp.md) / [Discord](./configuration/channel-discord.md) / [Slack](./configuration/channel-slack.md) / [QQ](./configuration/channel-qq.md) / [WeCom](./configuration/channel-wecom.md) / [Lark](./configuration/channel-feishu.md)

- [Configurar Skills](./configuration/skill.md) — Uso de Skills.sh / ClawHub e instalación de Skills

Referencias relacionadas:

- [Conceptos Fundamentales](./04-core-concepts.md)

- [Inicio Rápido](./02-quickstart.md)
