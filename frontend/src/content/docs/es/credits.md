# Créditos

## Resumen

Los créditos de modelo son la unidad que LightVela utiliza para medir cuánto gasta tu Hermes Agent en llamadas a modelos, contando tanto la entrada como la salida. Los créditos se incluyen en tu plan mensualmente, no se venden por separado y se reinician cada ciclo de facturación: Launch incluye 100 créditos al mes, y Cruise ofrece una cantidad mayor. Los créditos se consumen cada vez que el Agent habla contigo, ejecuta una tarea automatizada o utiliza una Skill — todo lo cual termina llamando al modelo — y las conversaciones más largas con más contexto las agotan más rápido. Si te quedas sin créditos a mitad de ciclo, las funciones dependientes del modelo se limitan hasta la siguiente asignación, o puedes cambiar a tu propia clave de API de modelo en la configuración del modelo y continuar.

---

Los créditos de modelo son las unidades que LightVela utiliza para medir el uso de modelos por un Hermes Agent. Cada plan incluye una asignación mensual de créditos. Cada vez que tu Agent llama a un modelo de lenguaje durante una conversación o tarea, se deducen créditos según el uso. Esta página explica qué son los créditos, cómo se asignan y se consumen, y cómo se relacionan con los planes.

## ¿Qué cubre esta página?

- ¿Qué significan los créditos de modelo y cómo se convierten

- Cómo los planes asignan créditos cada mes

- Cómo se consumen los créditos y cómo se relacionan con los tokens

- Cómo los créditos se relacionan con los planes y los modelos

---

## ¿Qué son los créditos de modelo?

Los créditos de modelo son la **unidad de medida** para las llamadas a modelos de lenguaje realizadas por un Hermes Agent. Cada vez que tu Agent responde en una conversación, ejecuta una [automatización](./configuration/automation.md) o utiliza una Skill, envía solicitudes al modelo subyacente. Los tokens utilizados por esas solicitudes se convierten en créditos.

La conversión aproximada es **1 crédito ≈ 10,000 tokens**. Un token es la unidad básica de texto procesada por un modelo. Tanto la entrada —el contenido que envías a tu Agent— como la salida —la respuesta que genera— cuentan hacia el uso.

> ℹ️ La conversión exacta y las reglas de medición mostradas por la plataforma son autoritativas. El costo por token puede variar entre modelos.

---

## Cómo se asignan los créditos

Los créditos se **asignan mensualmente con un plan**, y la cantidad mensual difiere según el nivel:

| Plan | Créditos de modelo (asignación estándar) |
|---|---|
| Launch | 100 créditos / mes |
| Cruise | 200 créditos / mes |

Algunos planes pueden ofrecer una **asignación de créditos más alta**. Consulta las tarjetas de plan en la [página Suscribirse](/subscribe) para las opciones actualmente disponibles, y ve [Planes](./plans.md) para la estructura de recursos y créditos de cada nivel.

---

## Cómo se consumen los créditos

Los créditos se consumen en las siguientes situaciones porque cada una requiere que Hermes llame a un modelo de lenguaje:

- **Hablar con tu Agent** — Mensajeo a través de Telegram, WhatsApp, Discord, Slack, WeChat o otro canal soportado

- **Ejecutar automatizaciones** — Permitir que tu Agent ejecute [tareas programadas](./configuration/automation.md)

- **Utilizar Skills** — Permitir que una Skill llame a un modelo para razonar durante la ejecución

El uso depende de la longitud de la conversación y el modelo seleccionado. El contenido más largo y más contexto generalmente utilizan más tokens y, por lo tanto, más créditos. Elegir un modelo más económico y mantener el contexto enfocado puede reducir el uso. Consulta [Configurar Modelos](./configuration/model.md).

---

## Cómo los créditos se relacionan con los planes y los modelos

- **Vinculado a un plan**: Los créditos son parte de los recursos de un plan y se asignan en su ciclo mensual. Cualquier método actualmente disponible para obtener o complementar créditos se muestra en la [página Suscribirse](/subscribe) y se rige por las reglas más recientes de la plataforma.

- **Dependiente del modelo**: Los modelos pueden tener diferentes costos por token, por lo que la misma conversación puede consumir un número diferente de créditos con un modelo diferente.

- **Ciclo de asignación**: Los créditos se asignan mensualmente. El rollover y la expiración siguen las reglas actuales de la plataforma.

Si utilizas todos los créditos del periodo actual, las funciones del Agent que dependen de llamadas a modelos se limitan hasta que esté disponible una nueva asignación o la plataforma ofrezca otra opción.

---

## Preguntas frecuentes

### ¿Cómo se relacionan los créditos con un plan?

Los créditos son recursos incluidos con un plan y se asignan mensualmente. La disponibilidad actual y cualquier precio futuro para diferentes opciones de créditos se muestra en la [página Suscribirse](/subscribe).

### ¿Cuánto dura un crédito?

Un crédito es aproximadamente 10,000 tokens. El número de vueltas de conversación que soporta depende de la longitud de cada entrada y salida y del modelo seleccionado, por lo que no hay una conversión fija a mensajes. Las conversaciones más largas generalmente consumen créditos más rápido.

### ¿Todos los modelos consumen créditos a la misma tasa?

No. Los modelos tienen diferentes costos por token, por lo que la misma tarea puede consumir un número diferente de créditos dependiendo del modelo. Elige el modelo que se adapte a tus necesidades en [Configurar Modelos](./configuration/model.md).

### ¿Puedo continuar después de usar todos mis créditos?

Las funciones que requieren llamadas a modelos se limitan después de agotar la asignación. Cuando se hace disponible una nueva asignación, o si se ofrece otra opción, depende de las reglas actuales de la plataforma.

---

## Próximos pasos

- [Planes](./plans.md) — Compara recursos y asignaciones de créditos por nivel

- [Configurar Modelos](./configuration/model.md) — Elige un modelo más económico o más capaz

- [Activar tu primer instancia de Hermes](./create-first-hermes.md) — De la activación del plan a un Agent en funcionamiento

- [Conceptos básicos](./04-core-concepts.md) — Entiende Hermes, modelos, canales y Skills
