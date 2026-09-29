# Créditos

## Resumen

**Los créditos de modelo miden las llamadas al modelo, tanto la entrada como la salida. Launch, Launch AI, Cruise y Cruise AI incluyen 100, 4500, 200 y 10 000 créditos al mes, respectivamente. Los usuarios con un plan activo también pueden comprar paquetes de créditos de pago único, válidos durante un mes desde su entrega y sin renovación automática. Las conversaciones y las Agent Tasks que usan el modelo consumen créditos; las Notification Tasks y Script Tasks no lo llaman. Si se agotan, puedes comprar un paquete admisible, esperar la siguiente asignación o configurar tu propia clave de API.**

---

Los créditos de modelo son las unidades que LightVela utiliza para medir el uso de modelos por un Hermes Agent. Cada plan incluye una asignación mensual de créditos. Cada vez que tu Agent llama a un modelo de lenguaje durante una conversación o tarea, se deducen créditos según el uso. Esta página explica qué son los créditos, cómo se asignan y se consumen, y cómo se relacionan con los planes.

## ¿Qué cubre esta página?

- ¿Qué significan los créditos de modelo y cómo se convierten

- Cómo los planes asignan créditos cada mes

- Cómo se consumen los créditos y cómo se relacionan con los tokens

- Cómo los créditos se relacionan con los planes y los modelos

---

## ¿Qué son los créditos de modelo?

Los créditos miden las llamadas a un modelo de lenguaje. Las conversaciones, las [Agent Tasks](./configuration/automation.md) que llaman al modelo y las Skills que lo usan consumen créditos; las Notification Tasks y Script Tasks no llaman al modelo.

La conversión aproximada es **1 crédito ≈ 10,000 tokens**. Un token es la unidad básica de texto procesada por un modelo. Tanto la entrada —el contenido que envías a tu Agent— como la salida —la respuesta que genera— cuentan hacia el uso.

> ℹ️ La conversión exacta y las reglas de medición mostradas por la plataforma son autoritativas. El costo por token puede variar entre modelos.

---

## Cómo se asignan los créditos

Los créditos se **asignan mensualmente con un plan**, y la cantidad mensual difiere según el nivel:

| Plan | Créditos de modelo al mes |
|---|---:|
| Launch | 100 |
| Cruise | 200 |
| Launch AI | 4500 |
| Cruise AI | 10 000 |

Consulta [Planes](./plans.md) para ver los recursos y la [página de suscripción](/subscribe) para conocer la disponibilidad y el precio actuales.

## Paquetes de créditos adicionales

Los usuarios con un plan activo pueden comprar un paquete de créditos de modelo de pago único en la [página de suscripción](/subscribe#subscribe-credits). El paquete es válido durante un mes desde su entrega y no se renueva automáticamente. Se consumen primero los créditos que vencen antes; si la fecha es la misma, se usan primero los más antiguos. Consulta el precio y las cantidades disponibles al pagar.

---

## Cómo se consumen los créditos

Los créditos se consumen en las siguientes situaciones porque cada una requiere que Hermes llame a un modelo de lenguaje:

- **Hablar con tu Agent** — Mensajeo a través de Telegram, WhatsApp, Discord, Slack, WeChat o otro canal soportado

- **Ejecutar Agent Tasks** — El Agent ejecuta [tareas programadas](./configuration/automation.md) que llaman al modelo

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

Los créditos se asignan cada mes con el plan. Los suscriptores con un plan activo también pueden comprar paquetes de pago único. Consulta las opciones y precios actuales en la [página de suscripción](/subscribe).

### ¿Cuánto dura un crédito?

Un crédito es aproximadamente 10,000 tokens. El número de vueltas de conversación que soporta depende de la longitud de cada entrada y salida y del modelo seleccionado, por lo que no hay una conversión fija a mensajes. Las conversaciones más largas generalmente consumen créditos más rápido.

### ¿Todos los modelos consumen créditos a la misma tasa?

No. Los modelos tienen diferentes costos por token, por lo que la misma tarea puede consumir un número diferente de créditos dependiendo del modelo. Elige el modelo que se adapte a tus necesidades en [Configurar Modelos](./configuration/model.md).

### ¿Puedo continuar después de usar todos mis créditos?

Puedes comprar un paquete admisible, esperar la siguiente asignación del plan o configurar tu propia clave de API. Las funciones que llaman al modelo se limitan si no hay créditos ni clave disponibles.

---

## Próximos pasos

- [Planes](./plans.md) — Compara recursos y asignaciones de créditos por nivel

- [Configurar Modelos](./configuration/model.md) — Elige un modelo más económico o más capaz

- [Activar tu primer instancia de Hermes](./create-first-hermes.md) — De la activación del plan a un Agent en funcionamiento

- [Conceptos básicos](./04-core-concepts.md) — Entiende Hermes, modelos, canales y Skills
