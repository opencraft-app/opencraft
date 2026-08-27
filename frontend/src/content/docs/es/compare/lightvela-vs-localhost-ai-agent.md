# LightVela vs Selfhost Agent: ¿Cuál es el mejor?

## Resumen

**LightVela es la mejor opción si deseas un Hermes Agent que esté siempre activo sin tener que mantener el equipo que lo ejecuta.** Ejecutar Hermes en tu propio equipo es la mejor opción si deseas un control directo sobre el tiempo de ejecución, las herramientas, las actualizaciones y el entorno local. La respuesta correcta depende de si deseas operar el conjunto de configuración o simplemente utilizar el Agent.

Hermes puede ejecutarse localmente en macOS, Windows, Linux, WSL2 y más. Su instalador oficial configura el tiempo de ejecución y luego te permite elegir el proveedor de modelos, las herramientas y la pasarela de mensajería tú mismo. La [guía de instalación de Hermes](https://hermes-agent.nousresearch.com/docs/getting-started/installation) hace que ese camino sea bastante accesible.

> **Accesible no significa invisible.** Un Agent local te da control, pero también te da la responsabilidad de mantener el entorno listo.

![Configuración en la nube de LightVela comparada con la ejecución local de Hermes](../images/lightvela-vs-self-hosted-hermes.webp)

## En un vistazo

| Lo que importa para ti | Ejecutar Hermes en tu equipo | Usar LightVela |
| - | - | - |
| **Dónde se ejecuta Hermes** | Tu propia máquina | Un tiempo de ejecución en la nube dedicado |
| **Control día a día** | Tú eliges la configuración local y el entorno | Gestionas el Agent a través de una consola alojada |
| **Disponibilidad** | Mantienes el equipo y el proceso disponibles | Diseñado para permanecer en línea independientemente de tu dispositivo local |
| **Responsabilidad de configuración** | Tú configuras el tiempo de ejecución, el modelo, las herramientas y los canales | El entorno del Agent principal se aloja por ti |
| **Mejor ajuste** | Constructores que disfrutan de tener la pila en su propiedad | Personas que quieren usar Hermes sin operar la pila |

## ¿Qué cambia en el uso diario

El camino local es satisfactorio cuando te gusta saber exactamente dónde se encuentran las cosas.

Instalas Hermes, eliges un proveedor de modelos, habilitas herramientas y agregas una pasarela cuando deseas acceso a la mensajería. La propia guía de inicio rápido de Hermes recomienda obtener una conversación limpia funcionando antes de añadir pasarelas, Skills, voz o enrutamiento, lo cual es un consejo sensato para cualquier configuración autoadministrada. La [guía de inicio rápido de Hermes](https://hermes-agent.nousresearch.com/docs/getting-started/quickstart/) también muestra que una instalación local puede crecer en un bot o un flujo de trabajo siempre activo.

Esa flexibilidad es el punto. Puedes experimentar con tu propio entorno, elegir cómo ocurren las actualizaciones y construir alrededor del equipo que ya utilizas.

La compensación aparece más tarde, en los momentos ordinarios:

- **Disponibilidad:** Tu equipo debe permanecer disponible para que el Agent permanezca disponible.
- **Mantenimiento:** Tú eres la persona que nota cuando una configuración de modelo, una herramienta, una pasarela o una actualización necesita atención.
- **Alcance:** "Solo una cosa más" puede lentamente convertir una configuración personal en algo que mantienes.

Eso no es una razón para evitar la autohosting. Simplemente es el trabajo que estás aceptando.

## ¿Dónde LightVela es la mejor opción?

LightVela tiene más sentido cuando tu objetivo es tener un Hermes Agent que trabaje por ti, no para operar la máquina que lo ejecuta.

LightVela ejecuta una instancia dedicada de Hermes Agent en la nube. El Agent permanece en línea independientemente de tu dispositivo local, mientras que tú gestionas las partes prácticas—[modelos](https://lightvela.ai/docs/configuration/model), [canales](https://lightvela.ai/docs/configuration) y [Skills](https://lightvela.ai/docs/configuration/skill)—desde la consola. La [visión general de LightVela](https://lightvela.ai/docs/overview) explica el modelo alojado, incluyendo tiempos de ejecución aislados y acceso multi-canal.

Eso cambia la sensación de usar Hermes. Puedes conectar el Agent al canal donde ya hablas—como [Telegram](https://lightvela.ai/docs/configuration/channel-telegram), [WhatsApp](https://lightvela.ai/docs/configuration/channel-whatsapp), [Discord](https://lightvela.ai/docs/configuration/channel-discord) o [Slack](https://lightvela.ai/docs/configuration/channel-slack)—y luego seguir utilizando incluso cuando tu portátil esté cerrado. Todavía tomas las decisiones significativas, pero no necesitas convertir tu equipo personal en el lugar donde se mantiene la disponibilidad.

Para muchas personas, la distinción útil es simple:

> **LightVela te da menos configuración para controlar. La autohosting te da más control sobre la configuración.**

Si principalmente quieres configurar tu Agent y volver a tu trabajo, la consola alojada suele ser el punto de partida más cómodo. Todavía puedes configurar modelos, canales y Skills en un solo lugar a través de la [visión general de configuración de LightVela](https://lightvela.ai/docs/configuration).

## ¿Dónde ejecutar Hermes en tu propio equipo es la mejor opción?

Elige una configuración local cuando construir y controlar el tiempo de ejecución es parte del proyecto—quizás para un flujo de trabajo de escritorio, un laboratorio en casa o experimentación con modelos a mano.

Tendrás propiedad de las actualizaciones, las credenciales y la disponibilidad. "En mi equipo" tampoco hace que cada modelo, herramienta de navegador o servicio conectado sea local, así que sé preciso sobre lo que estás controlando.

## ¿Cuál deberías elegir?

Elige LightVela si:

- **Quieres disponibilidad:** Quieres que Hermes esté listo sin dejar que tu equipo sea responsable de ello.
- **Prefieres la configuración:** Preferirías configurar un Agent que mantener su tiempo de ejecución.
- **Quieres una sola consola:** Quieres un lugar claro para gestionar modelos, canales y Skills.
- **Ya usas aplicaciones de mensajería:** Quieres un Agent siempre activo que se ajuste a los canales que ya utilizas.

Elige Hermes en tu propio equipo si:

- **Disfrutas de construir:** Te gusta la configuración basada en terminal y la experimentación a mano.
- **Quieres propiedad:** Quieres afinar el tiempo de ejecución alrededor de tu entorno personal.
- **Aceptas el mantenimiento:** Estás cómodo manejando la configuración de modelos, actualizaciones, herramientas y disponibilidad.

No hay necesidad de fingir que una respuesta es universalmente mejor. Empieza con la pregunta detrás de la pregunta: **¿quiero ejecutar infraestructura, o quiero un Agent que esté listo cuando lo necesite?**
