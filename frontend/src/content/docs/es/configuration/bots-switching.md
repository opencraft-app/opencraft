# Cambio entre Bots

## Resumen

**El cambio entre Bots permite que un Agent de LightVela en la nube contenga varios Bots especializados. Puedes crear Bots para investigación, planificación, programación, contenido, soporte o flujos de trabajo recurrentes, y cambiar entre ellos desde el menú del perfil del Agent.**

**Cada Bot tiene su propio contexto de espacio de trabajo. Según si creas un Bot vacío o clonas un Bot existente, LightVela aplica reglas de herencia diferentes para los modelos, la memoria, las Skills, la personalidad, las tareas programadas y las conexiones de canales.**

## Antes de empezar

- Inicia sesión en LightVela y abre un Agent en la nube activo.
- Para crear otro Bot, comprueba que tu plan actual permita crear uno más y que ningún otro Bot se esté creando o eliminando.
- Si vas a conectar un canal, prepara las credenciales o el método de autorización que necesita ese canal.

## Crear tu Bot

Tras iniciar sesión con Google o GitHub y activar un plan disponible, abra la [consola del Agent](/agents/overview/). Complete la configuración del primer Bot: introduzca el nombre obligatorio, añada una descripción opcional y ajuste su apariencia. Seleccione **Crear** y espere a que terminen la creación y la configuración inicial. Cuando termine la configuración, seleccione **Empieza tu viaje** y abra el chat web de ese Bot. El canal de mensajería es opcional; las respuestas requieren créditos de modelo disponibles o un modelo configurado.

Para crear otro Bot, seleccione **Nuevo bot** si la opción está disponible y el plan tiene capacidad. Introduzca **Nombre** (obligatorio) y **Descripción** (opcional), y ajuste la apariencia si lo necesita. La opción predeterminada es **Crear en blanco**. Si hay Bots válidos para copiar, abra **Avanzado** y seleccione un Bot de origen concreto. Para copiar el Bot que está usando, abra **Gestionar bot → Copiar Bot**; el formulario selecciona ese origen. Revise el origen, seleccione **Crear** y espere a que termine.

El control para cerrar y las opciones avanzadas de copia solo aparecen cuando hay Bots de origen válidos. La primera configuración sin origen debe completarse. Los controles de apariencia cambian el color, la forma y los accesorios; no seleccionan el origen de la copia.

Las capturas siguientes muestran el formulario actual para crear un Bot adicional y sus plantillas recomendadas. El control para cerrar y la sección Avanzado están disponibles porque este Agent ya tiene Bots; no es la pantalla de configuración del primer Bot.

![Formulario de creación de un Bot de LightVela con selector de avatar, campos de nombre y descripción y botón Crear](../../images/bots-switching-create.webp)

![Plantillas recomendadas en el formulario de creación de un Bot adicional de LightVela](../../images/bots-switching-templates.webp)

## Espacio de trabajo y configuración del Bot

Seleccione el avatar del Bot deseado en la barra de Bots. En pantallas estrechas, abra primero el panel de navegación. Compruebe su nombre antes de cambiar modelos, memoria, Skills, canales o tareas programadas. El chat web y la lista de conversaciones pertenecen al Bot seleccionado; los Bots adicionales también pueden usar el chat web. No necesita conectar un canal de mensajería para usarlo.

![Barra de avatares de Bots junto a la navegación de Canales, Skills y Tareas programadas de LightVela](../../images/bots-switching-overview.webp)

El modo de creación determina qué hereda el nuevo Bot:

| Modo de creación | Se hereda | Se inicia por separado |
| --- | --- | --- |
| Crear en blanco | El modelo principal y sus credenciales del proveedor, además de las Skills proporcionadas por el sistema | Modelos de respaldo, otros modelos configurados, personalidad, memoria, Skills instaladas después en el Bot principal, canales y tareas programadas |
| Copiar Bot | Modelos, personalidad, Skills, preferencias del usuario y memoria a largo plazo | Conversación actual, historial de chats, tareas programadas, estado de ejecución y conexiones de canales |

Revisa el diálogo de creación antes de confirmar si necesitas mantener la configuración separada. Después puedes administrar de forma independiente la [memoria](./memory.md), las [Skills](./skill.md) y las [tareas programadas](./automation.md) de cada Bot.

## ¿Por qué crear los Bots de forma independiente?

Un Bot puede encargarse de muchas tareas, pero su contexto se vuelve más difícil de gestionar a medida que aumentan sus responsabilidades. Un investigador, planificador de viajes, analista financiero o verificador de calidad dedicado puede mantener un conjunto más enfocado de memorias, Skills, ajustes de personalidad y tareas programadas.

Los Bots independientes también facilitan probar otro estilo de trabajo sin cambiar el Bot que ya usas para otra tarea.

![Barra de avatares de LightVela con dos Bots y el control para crear otro Bot](../../images/bots-switching-selector.webp)

Seleccione el avatar del Bot deseado en la barra de Bots. En pantallas estrechas, abra primero el panel de navegación. Compruebe su nombre antes de cambiar modelos, memoria, Skills, canales o tareas programadas. El chat web y la lista de conversaciones pertenecen al Bot seleccionado; los Bots adicionales también pueden usar el chat web. No necesita conectar un canal de mensajería para usarlo.

## Cómo usar varios Bots a la vez

Puedes conectar varios Bots a los canales de mensajería compatibles. Las combinaciones de canales disponibles dependen de la región de LightVela:

| Versión de LightVela | Canales que admiten la integración de varios Bots |
| --- | --- |
| Versión global | Telegram, Discord, Slack, QQ, WeCom, Lark |

En canales como WeChat y WhatsApp, la configuración actual puede permitir solo un Bot por instancia. Si otro Bot ya posee un canal, LightVela muestra un aviso y proporciona una forma de administrar el Bot que lo posee.


## Verificar un cambio de Bot o una conexión de canal

Después de cambiar o conectar un Bot, comprueba lo siguiente:

1. El nombre y el avatar del Bot activo cambian al Bot seleccionado.
2. La página de configuración muestra el espacio de trabajo y la configuración del Bot seleccionado.
3. El canal conectado aparece bajo el Bot que posee la conexión.
4. Un mensaje de prueba corto llega al Bot previsto y recibe una respuesta.

Para un canal de grupo, envía un mensaje de prueba con el nivel de permisos configurado. Confirma si el Bot solo puede leer el contexto del grupo o también puede responder.

## Problemas comunes

| Problema | Causa probable | Qué hacer |
| --- | --- | --- |
| **Nuevo Bot** no está disponible | El plan alcanzó el límite de Bots o todavía se está creando o eliminando otro Bot | Espera a que termine la operación, elimina un Bot que ya no uses o cambia a un plan con un límite superior |
| Una opción de clonación no está disponible | No hay un Bot actual o principal válido para copiar | Elige **Crear vacío** o vuelve al Bot previsto antes de abrir el diálogo de creación |
| La lista de Bots no está disponible temporalmente | La instancia del Agent está detenida o la solicitud de la lista de Bots falló | Inicia o actualiza el Agent y vuelve a cargar la página de configuración de Bots |
| Un canal ya está conectado a otro Bot | El canal tiene una restricción de propiedad de un solo Bot | Usa el aviso para abrir el Bot propietario, o desconecta y vuelve a conectar el canal según la página de configuración correspondiente |
| Un mensaje de grupo no recibe respuesta | Los permisos de grupo o la configuración del canal del Bot están incompletos | Revisa la página de configuración de [Telegram](./channel-telegram.md), [Discord](./channel-discord.md) u otro canal y vuelve a enviar un mensaje de prueba |

## Chatear con tus Bots en grupos

Puedes invitar varios Bots a los chats de grupo compatibles. Según el nivel de permisos configurado, un Bot puede leer el contexto del grupo, responder a las preguntas de los usuarios o hacer ambas cosas.

El comportamiento y los pasos de configuración de los grupos varían según la plataforma. Sigue la página de configuración del canal correspondiente antes de invitar al Bot y prueba el Bot con una mención directa u otro activador compatible con la plataforma cuando sea necesario.
