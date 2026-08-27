# ¿Qué es LightVela

## Resumen

**LightVela es una plataforma de Agents alojada en la nube del equipo de Tencent Lighthouse, y su producto actual es Hermes Agent — un Agent de IA construido sobre modelos de lenguaje grandes. LightVela se encarga de la implementación, la operación y la disponibilidad 24/7 en la nube, por lo que nunca tienes que escribir archivos de configuración ni conectarte por SSH a un servidor: todo lo configuras haciendo clic y arrastrar en un panel visual, y luego hablas con tu Agent a través de las aplicaciones de mensajería que ya utilizas. Se recuerda a través de las conversaciones, y tú eliges el modelo, las herramientas y la personalidad. LightVela planea entrar en beta pública con facturación habilitada el 18 de agosto de 2026 (hora de Singapur); los planes de beta cerrado existentes se extenderán por un mes adicional, y los nuevos usuarios pueden probar el plan Launch gratis por 14 días. Consulta la página de suscripción para el estado actual.**

---

> Un Hermes Agent alojado en la nube que te entiende mejor con el tiempo.

> ℹ️ **Aviso de beta pública y facturación**
>
> LightVela está entrando en beta pública e iniciando la facturación. La documentación y las capacidades del producto aún están evolucionando, y algunas descripciones pueden cambiar a medida que se lanzan nuevas versiones.
>
> * **Beta público y facturación**: LightVela planea entrar en beta pública e iniciar la facturación el 18 de agosto de 2026 (hora de Singapur). Después de que el beta pública y la facturación comiencen oficialmente, la validez del plan existente de los usuarios beta se extenderá por un mes adicional. Consulta [Anuncio de la versión pagada de LightVela](./announcements/public-beta.md).
>
> * **Beneficio para nuevos usuarios después del inicio del beta pública y la facturación**: Los nuevos usuarios pueden probar el plan Launch gratis por 14 días.

LightVela es un producto de alojamiento de Agents en la nube del equipo de Tencent Lighthouse. Está diseñado para permitir que todos posean un **compañero de IA que verdaderamente les pertenece** —no una herramienta que te pida que te presentes cada vez, sino una presencia a largo plazo que **te conoce, te recuerda y te entiende mejor con el tiempo**.

Tu Agent permanece en línea 24/7, se ejecuta de forma independiente y siempre está listo para chatear. Tú decides su modelo, sus herramientas y su personalidad.

Reducimos la barrera de configuración mediante una consola visual: sin archivos de configuración, sin inicio de sesión en el servidor, solo selecciona opciones en la página web para completar la configuración.

El producto actual de LightVela es **Hermes Agent**, un Agent de IA impulsado por modelos de lenguaje grandes. Es posible que se agreguen más productos listos para usar en el futuro. Esta documentación se centra en Hermes Agent.

![1.00](./images/1-1.webp)

***

## Para quién está destinado

* Usuarios que desean utilizar un Agent de IA pero no tienen conocimientos técnicos de servidores, contenedores, autenticación de API e infraestructura relacionada

* Usuarios que prefieren interactuar con la IA a través de plataformas de mensajería diarias (Telegram / WhatsApp / Discord / Slack / WeChat) en lugar de una aplicación independiente

* Usuarios que desean elegir entre múltiples proveedores de modelos de lenguaje grandes (incluyendo ChatGPT, Claude, Gemini, Deepseek, Qwen, Zhipu, Hunyuan y más)

* Usuarios que necesitan memoria persistente entre conversaciones en lugar de empezar desde cero cada vez

## No adecuado para

* Usuarios que requieren ejecución completamente local sin que los datos salgan de su dispositivo

* Usuarios que necesitan entrenar o ajustar el modelo subyacente

* Desarrolladores que necesitan integrar un Agent en su propio sitio web o aplicación

***

## Características del producto

* **Implementación totalmente gestionada**: La nube se encarga automáticamente de la configuración del entorno y la gestión del tiempo de ejecución. No se requieren operaciones de servidor, imágenes de contenedor ni conocimientos de infraestructura

* **Entorno de tiempo de ejecución aislado**: Cada instancia de Hermes Agent tiene su propio entorno de tiempo de ejecución, aislamiento de recursos, disponibilidad 24/7 y no depende de dispositivos locales

* **Soporte multi-modelo**: Conéctate a modelos de lenguaje grandes chinos principales, suscripciones a planes de codificación de proveedores o cualquier punto de extremo compatible con OpenAI. Consulta [Configurar modelos](./configuration/model.md)

* **Acceso multi-canal**: Chatea con Hermes Agent a través de Telegram, WhatsApp, Discord, Slack, WeChat, QQ, WeCom y Lark

* **Extensiones de Skills**: Instala paquetes de Skills desde [SkillHub](https://skillhub.tencent.com) para extender las capacidades de Hermes Agent

* **Listo para usar**: El plan Launch incluye créditos de prueba, por lo que puedes comenzar a chatear después de la activación sin configurar un modelo por separado

* **Almacenamiento en la nube dedicado**: Los datos de conversación y memoria se almacenan de forma independiente

***

## Cómo funciona

LightVela ejecuta una instancia dedicada de Hermes Agent para cada usuario en la nube, y luego la conecta a la plataforma de mensajería seleccionada por el usuario a través de una capa de adaptador.

```
User (sends a message in Telegram / WhatsApp / Discord / Slack / WeChat)
      ↓
User-dedicated Hermes Agent instance in the LightVela cloud
      ↓
Calls the configured large language model (GPT / Claude / Gemin / ...)
      ↓
Response returns through the original channel
```

Un ciclo de conversación completo requiere tres configuraciones:

1. **Modelo**: El modelo de lenguaje grande llamado por Hermes Agent. El plan Launch incluye créditos de prueba y se puede utilizar directamente; también puedes configurar tu propia API Key

2. **Canal**: La plataforma de mensajería utilizada para chatear con Hermes Agent (Telegram / WhatsApp / Discord / Slack / WeChat)

3. **Skill** (opcional): Capacidades adicionales para Hermes Agent

![1.00](./images/1-2.webp)

***

## Sobre los planes

LightVela utiliza facturación basada en planes. Activar un plan te otorga una instancia disponible de Hermes Agent y los recursos y créditos incluidos en ese plan.

Planes actualmente disponibles:

| Plan | Precio original | Estado actual |
| --------- | ------- | ---- |
| Launch | $7.5 / mes | Prueba gratuita de 14 días para nuevos usuarios después del inicio del beta pública y la facturación |
| Cruise | $15 / mes | Plan pagado |

El plan Launch incluye: 1 instancia de Hermes Agent, entorno de tiempo de ejecución aislado de 2 núcleos 4G, 50 GB de almacenamiento en la nube dedicado, 100 créditos de prueba, disponibilidad 24/7 y acceso a la consola.

> ℹ️ **Aviso de plan beta**
>
> LightVela planea entrar en beta pública e iniciar la facturación el 18 de agosto de 2026 (hora de Singapur). Después de que el beta pública y la facturación comiencen oficialmente, la validez del plan existente de los usuarios beta se extenderá por un mes adicional, y los nuevos usuarios pueden probar Launch gratis por 14 días. Consulta [Anuncio de la versión pagada de LightVela](./announcements/public-beta.md).

***

## Relación con Lighthouse (opcional)

Para usuarios familiarizados con Tencent Cloud: LightVela puede entenderse como un paquete listo para usar de las capacidades de implementación de Agents en la nube de Tencent Lighthouse. LightVela elimina conceptos como cuentas de Tencent Cloud, gestión de recursos y operaciones de recursos en la nube, dejando solo dos acciones centrales: configurar un Agent y conectarlo a una plataforma de mensajería.

Si eres nuevo en los Agents en la nube, puedes omitir esta sección.

***

## Próximos pasos

* **[Inicio rápido](./02-quickstart.md)** — Completa tu primera conversación en 5 minutos

* **[Conceptos centrales](./04-core-concepts.md)** — Entiende los cuatro conceptos centrales: Hermes Agent, modelos, canales y Skills

* **[Resumen de configuración](./05-configuration.md)** — Características de la consola y flujo de configuración
