# Conceptos fundamentales

## Resumen

**LightVela tiene cuatro conceptos fundamentales. Un Hermes Agent es la entidad conversacional ejecutada en la nube, con su propio entorno de ejecución aislado, memoria que persiste entre conversaciones y disponibilidad 24/7. El modelo es el modelo de lenguaje grande que invoca —ya sea un Plan de Codificación de Modelo (mensual), API de Modelo (pago por uso) o un punto de extremo personalizado compatible con OpenAI. Los canales son las plataformas de mensajería a través de las cuales interactúas con él; múltiples canales pueden conectarse al mismo Agent y compartir una sola personalidad y memoria. Las Skills son paquetes de capacidades instalables que extienden lo que puede hacer. Una conversación completa fluye de la siguiente manera: un canal recibe tu mensaje, el Agent decide si invocar una Skill, llama al modelo para generar una respuesta y la respuesta regresa por el mismo canal.**

---

LightVela involucra cuatro conceptos fundamentales: Hermes Agent, modelos, canales y Skills. Esta página explica sus roles. Para pasos de configuración detallados, consulta las páginas de configuración correspondientes.

## Esta página cubre

- La relación entre los cuatro conceptos
- Características de una instancia de Hermes Agent
- La posición y los puntos de entrada de configuración de modelos, canales y Skills
- El flujo interno de una conversación completa

---

## Relación de conceptos

```
┌──────────────────────────────────────────────────────────────┐
│                         Hermes Agent                         │
│              (Agent running in the LightVela cloud)           │
└──────────────────────────────────────────────────────────────┘
      │                          │                        │
┌─────┘                          │                        └──────┐
▼                                ▼                               ▼
┌───────┐                   ┌────────┐                   ┌────────┐
│ Model │                   │Channel │                   │ Skill  │
└───────┘                   └────────┘                   └────────┘
 Model provider    Telegram/WhatsApp/Discord/Slack/WeChat      SkillHub
```

| Concepto | Rol | Descripción |
|---|---|---|
| Hermes Agent | Sujeto de conversación | La instancia del Agent de IA en sí |
| Modelo | Capacidad de lenguaje | El modelo de lenguaje grande invocado por Hermes Agent |
| Canal | Punto de entrada de interacción | La plataforma donde los usuarios chatean con Hermes Agent |
| Skill | Extensión de capacidad | Paquetes de capacidades adicionales invocables por Hermes Agent |

![](./images/3-1.webp)

---

## Hermes Agent

Hermes Agent es la instancia de Agent de IA en LightVela. Crear un Hermes Agent es equivalente a iniciar una instancia de Agent independiente en la nube.

Hermes Agent tiene las siguientes características:

- **Entorno de ejecución aislado**: Cada Hermes Agent se ejecuta en un entorno dedicado aislado de otras instancias
- **Memoria persistente**: El contenido de la conversación se guarda entre sesiones y el Agent utiliza el contexto histórico al responder
- **Siempre en línea**: Se ejecuta 24/7 y no depende del dispositivo local del usuario

El plan actual de lanzamiento soporta la creación de hasta 1 instancia de Hermes Agent.

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

> ⚠️ **Solo un modelo activo**
>
> Actualmente, cada Hermes Agent puede tener solo una configuración de modelo activa. Para cambiar modelos, usa "Agregar como predeterminado" para sobrescribir la configuración anterior.

---

## Canales

Los canales son los puntos de entrada de plataforma de mensajería donde los usuarios chatean con Hermes Agent. LightVela actualmente soporta los siguientes canales:

| Canal | Método de acceso | Caso de uso |
|---|---|---|
| WeChat | Autorización mediante código QR | Uso personal diario, adecuado para usuarios en China |
| Telegram | Acceso mediante Token de Bot | Mensajería personal o de equipo, configuración simple, adecuado para tarea programada ligera |
| WhatsApp | Acceso mediante API de WhatsApp Business | Comunicación con usuarios internacionales, servicio al cliente, notificaciones y recordatorios |
| Discord | Acceso mediante Token de Bot | Operaciones comunitarias, comunidades de desarrolladores, grupos de juego o de intereses |
| Slack | Acceso mediante Token de Bot / Token de Aplicación | Colaboración de equipo, notificaciones de espacio de trabajo y flujos basados en canales |

Para WeChat, selecciona el canal y haz clic en "Autorizar acceso" para generar un código QR. Escáñalo con tu teléfono para completar la autorización.

Pasos de acceso detallados para cada canal: [Configurar Canal - WeChat](./configuration/channel-wechat.md) / [Telegram](./configuration/channel-telegram.md) / [WhatsApp](./configuration/channel-whatsapp.md) / [Discord](./configuration/channel-discord.md) / [Slack](./configuration/channel-slack.md).

> 💡 **Múltiples canales pueden coexistir**
>
> Múltiples canales pueden conectarse a la misma instancia de Hermes Agent y compartir memoria y comportamiento del Agent. No importa por qué canal se envíe un mensaje, el objetivo de la conversación es el mismo Hermes Agent.

---

## Skills

Las Skills son paquetes de capacidades adicionales invocables por Hermes Agent. Extienden a Hermes Agent más allá de la conversación básica para tareas específicas como organizar tareas pendientes, generar informes diarios, navegar por la web, generar imágenes y más.

Todas las Skills provienen de [SkillHub](https://skillhub.tencent.com), un mercado independiente de Skills lanzado por Tencent. En SkillHub, puedes navegar por Skills listadas y ver sus descripciones de características y ejemplos.

Introduce el nombre de la Skill registrada en SkillHub en la tarjeta "3. Skills" del console y haz clic en "Instalar Skill" para instalarla. También puedes pedir a Hermes Agent directamente en la conversación para instalar o eliminar Skills. Consulta [Configurar Skills](./configuration/skill.md).

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
