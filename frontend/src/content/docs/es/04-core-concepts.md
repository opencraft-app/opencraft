# Conceptos fundamentales

## Resumen

**LightVela tiene cinco conceptos fundamentales: Hermes Agent es la instancia en la nube; los Bots son perfiles independientes dentro de ella; cada Bot tiene ajustes de modelo, canales de mensajería y Skills, además de su propia personalidad, memoria y tareas programadas. Los canales de un mismo Bot comparten su comportamiento, pero los ajustes no se comparten automáticamente entre Bots. Un mensaje llega por un canal, el Bot puede usar una Skill y un modelo, y la respuesta vuelve por el mismo canal.**

---

Los cinco conceptos de LightVela son Hermes Agent, Bots, modelos, canales y Skills. Esta página explica su relación.

## Esta página cubre

- La relación entre los cinco conceptos
- Características de una instancia de Hermes Agent
- La posición y los puntos de entrada de configuración de modelos, canales y Skills
- El flujo interno de una conversación completa

---

## Relación de conceptos

```text
Hermes Agent (cloud instance)
  └─ Bot profiles (main Bot and optional additional Bots)
       ├─ Primary model and optional fallbacks
       ├─ Connected channels
       └─ Skills, Soul, memory, scheduled tasks
```

| Concepto | Rol | Descripción |
|---|---|---|
| Hermes Agent | Sujeto de conversación | La instancia del Agent de IA en sí |
| Bot | Perfil independiente | Tiene sus propios modelos, canales, Skills, personalidad, memoria y tareas programadas |
| Modelo | Capacidad de lenguaje | El modelo de lenguaje grande invocado por Hermes Agent |
| Canal | Punto de entrada de interacción | La plataforma donde los usuarios chatean con Hermes Agent |
| Skill | Extensión de capacidad | Paquetes de capacidades adicionales invocables por Hermes Agent |


---

## Hermes Agent

Hermes Agent es la instancia de Agent de IA en LightVela. Crear un Hermes Agent es equivalente a iniciar una instancia de Agent independiente en la nube.

Hermes Agent tiene las siguientes características:

- **Entorno de nube dedicado**: Cada Hermes Agent se ejecuta en su propio entorno, con recursos aislados de otras instancias
- **Memoria persistente**: El contenido de la conversación se guarda entre sesiones y el Agent utiliza el contexto histórico al responder
- **Siempre en línea**: Se ejecuta 24/7 y no depende del dispositivo local del usuario

El plan actual de lanzamiento soporta la creación de hasta 1 instancia de Hermes Agent.

---

## Bots

Cada Hermes Agent tiene un Bot principal y puede admitir Bots adicionales según el cupo del plan y la disponibilidad. Todos están en la misma instancia en la nube, pero mantienen separados sus ajustes y datos. Selecciona el Bot adecuado antes de cambiar modelos, canales, Skills o memoria. Consulta [Gestionar Bots](./configuration/bots.md).

---

## Modelos

Un modelo es el modelo de lenguaje grande (LLM) que impulsa el pensamiento y las respuestas de Hermes Agent. LightVela no entrena modelos por sí misma. En cambio, los usuarios seleccionan un método de invocación en la tarjeta "Modelo" del console:

| Método | Modo de facturación | Fuente de API Key | Caso de uso |
|---|---|---|---|
| Plan de Codificación de Modelo | Mensual | Proveedor | Uso de alta frecuencia |
| API de Modelo | Pago por uso | Proveedor | Uso de baja frecuencia o prueba |
| Modelo personalizado | Depende del punto de extremo | Proporcionado por el usuario | Conectar modelos internacionales o puntos de extremo compatibles con OpenAI |

Además, el plan de lanzamiento incluye 100 créditos de prueba, por lo que puedes chatear sin configuración adicional; después de agotar los créditos de prueba, puedes configurar tu propio API Key.

Para modelos soportados, adquisición de API Key y orientación para selección de modelos, consulta [Configurar Modelos](./configuration/model.md).

> Cada Bot usa un modelo principal a la vez. Puede tener otros modelos o alternativas configurados; cambiar el modelo activo no exige borrar la configuración anterior. Consulta [Cambio de modelo](./configuration/multiple-models.md).

---

## Canales

Los canales son los puntos de entrada de plataforma de mensajería donde los usuarios chatean con Hermes Agent. LightVela actualmente soporta los siguientes canales:

| Canal | Método de acceso | Caso de uso |
|---|---|---|
| WeChat | Autorización mediante código QR | Uso personal diario, adecuado para usuarios en China |
| Telegram | Acceso mediante Token de Bot | Mensajería personal o de equipo, configuración simple, adecuado para tarea programada ligera |
| WhatsApp | Escanear código QR con WhatsApp | Comunicación con usuarios internacionales, servicio al cliente, notificaciones y recordatorios |
| Discord | Acceso mediante Token de Bot | Operaciones comunitarias, comunidades de desarrolladores, grupos de juego o de intereses |
| Slack | Acceso mediante Token de Bot / Token de Aplicación | Colaboración de equipo, notificaciones de espacio de trabajo y flujos basados en canales |

En la tarjeta **WeChat** de **Channels**, selecciona **+ Connect** y escanea el código QR con el teléfono.

Pasos de acceso detallados para cada canal: [Configurar Canal - WeChat](./configuration/channel-wechat.md) / [Telegram](./configuration/channel-telegram.md) / [WhatsApp](./configuration/channel-whatsapp.md) / [Discord](./configuration/channel-discord.md) / [Slack](./configuration/channel-slack.md).

> 💡 **Múltiples canales pueden coexistir**
>
> Los canales conectados al mismo Bot comparten su personalidad y memoria. Los ajustes de otros Bots no se comparten automáticamente.

---

## Skills

Las Skills son paquetes de capacidades adicionales invocables por Hermes Agent. Extienden a Hermes Agent más allá de la conversación básica para tareas específicas como organizar tareas pendientes, generar informes diarios, navegar por la web, generar imágenes y más.

Las Skills del sitio internacional proceden de [Skills.sh](https://skills.sh/) y [ClawHub](https://clawhub.ai/). Explora estas fuentes en la página **Skills** de la consola y revisa la descripción antes de instalar.

Abre **Skills** en la consola, busca una Skill o explora **Skill Packages** y selecciona **Install**. Comprueba el resultado en **Installed**. Consulta [Configurar Skills](./configuration/skill.md).

> ⚠️ **Verificación de seguridad antes de instalar**
>
> Las Skills tienen permisos para llamar capacidades de Hermes Agent en tiempo de ejecución. Antes de instalar una Skill, confirma que el autor sea confiable y prefiere Skills con muchas descargas y buenas calificaciones.

---

## Flujo de interacción

Un flujo de conversación completo funciona de la siguiente manera:

1. El usuario envía un mensaje a Hermes Agent a través de un canal (como WeChat)

2. Hermes Agent determina si se necesita invocar una Skill basada en el mensaje

3. El modelo procesa el contexto y genera una respuesta

4. La respuesta regresa al usuario a través del canal original

---

## Próximos pasos

- [Resumen de configuración](./05-configuration.md) — Guía completa de características del console
- [Inicio rápido](./02-quickstart.md) — Ponerse en marcha cuando no se haya creado un Hermes Agent
