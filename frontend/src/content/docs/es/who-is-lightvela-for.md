# ¿Para quién es LightVela?

## Resumen

**LightVela es para personas que desean una compañía de IA de larga duración que las conozca y mejore a medida que hablan con ella, pero que no desean gestionar servidores, contenedores ni autenticación de API — especialmente para aquellos que prefieren hablar con IA dentro de las aplicaciones de mensajería que ya utilizan en lugar de otra aplicación independiente, y que necesitan memoria persistente para que nunca tengan que volver a presentarse. LightVela gestiona la implementación, la operación y la disponibilidad 24/7 en la nube; todo lo que tienes que hacer es configurarlo en el navegador. No es la opción adecuada si requiere ejecución completamente local con datos que nunca salgan de tu dispositivo, necesitas entrenar o ajustar el modelo subyacente, o deseas incrustar el Agent en tu propio sitio web o aplicación.**

---

LightVela es un producto de Agent alojado en la nube del equipo de Tencent Lighthouse. Está diseñado para **personas que desean una compañía de IA personal que permanezca en línea, aprenda su contexto y se vuelva más útil con el tiempo, sin tener que gestionar servidores, contenedores ni autenticación de API**. LightVela gestiona la implementación, la operación y la disponibilidad 24/7 en la nube. Configuras tu Agent en una consola web, luego hablas con tu Hermes Agent a través de Telegram, WhatsApp, Discord, Slack o WeChat.

Si aún estás orientándote, comienza con [¿Qué es LightVela?](./01-overview.md).

***

## Para quién está diseñado

LightVela es especialmente útil para:

* **Personas que desean un Agent de IA sin configuración técnica**
  No necesitas entender servidores, Docker, proxies inversos ni autenticación de API. Una vez que activas un plan disponible, LightVela configura y gestiona el entorno de ejecución en la nube para ti a través de una consola visual.

* **Personas que desean IA en las aplicaciones de mensajería que ya utilizan**
  Hermes se conecta a Telegram, WhatsApp, Discord, Slack y WeChat a través de [canales](./04-core-concepts.md). Puedes hablar con él donde ya ocurren tus conversaciones en lugar de cambiar a otra aplicación independiente.

* **Personas que desean flexibilidad en su elección de modelo de lenguaje**
  LightVela puede conectarse a ChatGPT, Claude, Gemini, DeepSeek, Qwen, Zhipu, Hunyuan y otros endpoints compatibles con OpenAI. Consulta [Configurar modelos](./configuration/model.md) para detalles de configuración.

* **Personas que necesitan memoria entre conversaciones**
  A diferencia de un chatbot básico, Hermes puede retener el contexto de la conversación y memorías a largo plazo entre sesiones, por lo que no tienes que presentarte cada vez.

* **Personas que desean un Agent que funciona de forma independiente y disponible 24/7**
  Cada instancia de Hermes se ejecuta en un entorno de nube aislado y permanece disponible sin depender de si tu dispositivo local está en línea.

***

## Casos de uso típicos

LightVela funciona particularmente bien para:

* **Un asistente de IA personal** para recordatorios, organización de información y preguntas a demanda. Consulta [Crear un asistente de IA personal con LightVela](./use-cases/personal-ai-assistant.md).

* **Un punto de extremo de conversación siempre disponible** conectando tu Agent a Telegram, WhatsApp, Discord, Slack o WeChat.

* **Tareas diarias programadas** que se ejecutan automáticamente y resumen la información que te importa.

* **Memoria a largo plazo y gestión de conocimiento personal**, con un Agent que se vuelve más útil a medida que trabajas juntos.

***

## Requisitos previos

Antes de comenzar, necesitas:

* Una cuenta de Google o GitHub para iniciar sesión en LightVela; el sitio internacional no requiere verificación de identidad en China

* Un plan actualmente disponible seleccionado y activado desde la [página de suscripción](/subscribe); después de la beta pública y el inicio de facturación, los nuevos usuarios pueden probar Launch gratis por 14 días

* Al menos una cuenta de mensajería compatible, como Telegram, WhatsApp, Discord, Slack o WeChat

No necesitas tu propio servidor ni experiencia en operaciones.

***

## Si no estás seguro

LightVela puede no ser la opción adecuada si necesitas una implementación completamente local donde los datos nunca salgan de tu dispositivo, deseas entrenar o ajustar un modelo base, o necesitas incrustar un Agent directamente en tu propio sitio web o aplicación.

***

## Siguientes pasos

* **[Inicio rápido](./02-quickstart.md)** — Completa tu primera conversación en aproximadamente cinco minutos

* **[Conceptos fundamentales](./04-core-concepts.md)** — Entiende Hermes, modelos, canales y Skills
