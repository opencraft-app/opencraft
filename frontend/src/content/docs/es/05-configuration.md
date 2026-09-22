# Visión general de la configuración

## Resumen

**Toda la configuración de LightVela se encuentra en la consola "Mi Hermes", que se abre desde la esquina superior derecha después de iniciar sesión. Las pestañas de Bot del Agent de Hermes actual aparecen en la parte superior, seguidas de tres botones de configuración: Modelos, Canales y Skills. Modelos permite elegir un Plan de Codificación de Modelo, una API de Modelo o un endpoint personalizado compatible con OpenAI. Canales conecta plataformas de mensajería mediante código QR, token o ID de aplicación. Skills instala paquetes de capacidades reutilizables. La consola también ofrece Chat, Tareas, gestión de memoria, almacenamiento en la nube, cambio de modelos y un centro de diagnóstico. Después de completar la configuración básica, el Bot puede conversar en sus canales conectados.**

---

La configuración de LightVela está centralizada en el consola "Mi Hermes" y consta de tres botones de configuración:

1. Modelos

2. Canales

3. Skills

Esta página introduce la estructura general del consola y la función de cada botón. Para operaciones detalladas, consulte las subpáginas correspondientes.

## Esta página cubre

- Cómo ingresar al consola

- Selector de Bots e información del Bot seleccionado

- Funciones y puntos de entrada de los tres botones de configuración

- Estado de éxito después de la configuración

- Operaciones comunes como gestionar Bots, cambiar modelos y conectar múltiples canales

---

## Ingresar al consola

Después de iniciar sesión, haga clic en "Mi Hermes" en la esquina superior derecha para ingresar al consola. La parte superior de la página proporciona un botón "Volver al Inicio".

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

## Tres botones de configuración

Los tres botones están dispuestos de izquierda a derecha. El orden de configuración recomendado es 1 → 2 → 3.

### 1. Canales

![](./images/4-2.webp)

**Propósito**: Conectar a Agent de Hermes con plataformas de mensajería y proporcionar puntos de entrada de conversación para los usuarios.

**Métodos de acceso por canal**:

| Canal | Método de acceso | Requisito |
|---|---|---|
| WeChat | Autorización mediante código QR | Un teléfono con WeChat instalado |
| Telegram | Acceso mediante Bot Token | Cree un Bot de Telegram a través de BotFather y obtenga un Bot Token |
| WhatsApp | Acceso mediante WhatsApp Business API | Cuenta de desarrollador de Meta, Cuenta de WhatsApp Business y configuración básica de Cloud API |
| Discord | Acceso mediante Bot Token | Cree una Aplicación en el Portal de Desarrolladores de Discord, agregue un Bot e invítelo a un servidor |
| Slack | Acceso mediante Bot Token / App Token | Cree una Aplicación de Slack, habilita el Modo Socket y obtenga los tokens de Bot/App |
| QQ | Acceso mediante AppID / AppSecret | Una cuenta de QQ; cree un bot en la Plataforma Abierta de QQ y obtenga AppID / AppSecret |
| WeCom | Autorización mediante código QR | Un teléfono con WeCom instalado |
| Lark | Autorización mediante código QR | Un teléfono con Lark instalado (o Lark de escritorio ya iniciado sesión) |

**Proporciona el botón**: Selector de canal, botón "Autorizar Acceso", introducción del canal seleccionado y enlace "Ver detalles", y lista de "Canales conectados".

Para más detalles, consulte [Configurar Canal - WeChat](./configuration/channel-wechat.md) / [Telegram](./configuration/channel-telegram.md) / [WhatsApp](./configuration/channel-whatsapp.md) / [Discord](./configuration/channel-discord.md) / [Slack](./configuration/channel-slack.md) / [QQ](./configuration/channel-qq.md) / [WeCom](./configuration/channel-wecom.md) / [Lark](./configuration/channel-feishu.md).

---

### 2. Modelos

![](./images/4-1.webp)

**Propósito**: Configurar un modelo de lenguaje grande para Agent de Hermes. El plan Launch incluye 100 créditos de prueba, por lo que puede omitir este paso inicialmente y configurar un modelo después de que se agoten los créditos.

**Proporciona el botón**: Selector de origen (Plan de Codificación de Modelo / API de Modelo / Modelo Personalizado), selector de modelo, entrada de Clave de API, introducción del proveedor, enlace para obtener Clave de API y lista de "Modelo actual".

> ⚠️ **Solo un modelo está activo**
>
> Actualmente, cada Agent de Hermes puede tener solo una configuración de modelo activa. Una nueva acción "Agregar como predeterminado" sobrescribe la configuración existente.

Para más detalles, consulte [Configurar Modelos](./configuration/model.md).

---

### 3. Skills

![](./images/4-3.webp)

**Propósito**: Extender las capacidades de Agent de Hermes, como organizar tareas pendientes, generar informes diarios y buscar en la web.

**Proporciona el botón**: Caja de búsqueda de nombre de Skill, botón "Instalar Skill", enlace "Ir a SkillHub" y lista de "Skills instaladas". Antes de la instalación, confirme el nombre exacto de la Skill en [SkillHub](https://skillhub.tencent.com).

> ⚠️ **Instale solo Skills confiables**
>
> Las Skills tienen permiso para llamar capacidades de Agent de Hermes en tiempo de ejecución. Instale solo Skills de fuentes confiables.

Para más detalles, consulte [Configurar Skills](./configuration/skill.md).

---

## Estado de éxito después de la configuración

Después de completar la configuración, el consola debe mostrar el siguiente estado:

- La lista de "Canales conectados" tiene al menos un registro (como "WeChat")

- "Modelo actual" es opcional; no se requiere configuración si utiliza los créditos de prueba de Launch

- "Skills instaladas" puede configurarse según sea necesario y puede estar vacío

Una vez que "Canales conectados" tenga al menos un registro, puede encontrar el bot en la plataforma de mensajería correspondiente y comenzar una conversación. Agent de Hermes generará respuestas utilizando el modelo predeterminado o los créditos de prueba de Launch.

---

## Operaciones comunes

### Cambiar modelos

En el botón "Modelo", elija el origen y el modelo nuevamente, ingrese la Clave de API y haga clic en "Agregar como predeterminado". La nueva configuración sobrescribe la anterior. Cambiar modelos no afecta la memoria de conversación.

### Conectar múltiples canales

En el botón "Canal", cambie las opciones del selector una por una y haga clic en "Autorizar Acceso". Los canales conectados al mismo Bot comparten la memoria y el comportamiento de ese Bot.

### Gestionar varios Bots

Use las pestañas de Bot para cambiar de perfil. Cuando la entrada de creación esté disponible, puede copiar el Bot actual o principal, o utilizar Basic setup. Consulte [Gestionar Bots](./configuration/bots.md) para conocer las reglas de herencia y eliminación.

---

## Próximos pasos

Configuración detallada para cada módulo:

- [Gestionar Bots](./configuration/bots.md) — Crear, copiar, cambiar, renombrar y eliminar Bots

- [Configurar Modelos](./configuration/model.md) — Fuentes de modelo, adquisición de Clave de API y guía de selección

- [Configurar Canal - WeChat](./configuration/channel-wechat.md) / [Telegram](./configuration/channel-telegram.md) / [WhatsApp](./configuration/channel-whatsapp.md) / [Discord](./configuration/channel-discord.md) / [Slack](./configuration/channel-slack.md) / [QQ](./configuration/channel-qq.md) / [WeCom](./configuration/channel-wecom.md) / [Lark](./configuration/channel-feishu.md)

- [Configurar Skills](./configuration/skill.md) — Uso de SkillHub e instalación de Skills

Referencias relacionadas:

- [Conceptos Fundamentales](./04-core-concepts.md)

- [Inicio Rápido](./02-quickstart.md)
