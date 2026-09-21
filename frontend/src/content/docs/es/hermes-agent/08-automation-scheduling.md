## Resumen

**Un Hermes Agent puede llegar a usted a tiempo no porque espere en una ventana de chat, sino porque una tarea programada guarda tres cosas — cuándo ejecutar, qué hacer y dónde enviar el resultado — como una configuración que puede programarse repetidamente. Cuando llegue la hora, el programador inicia una ejecución independiente: no reinterpreta una conversación antigua, vuelve a realizar el trabajo desde las instrucciones de la tarea y luego entrega la salida según sus configuraciones de notificación. En LightVela, una tarea programada consiste en: nombre, programación (días fijos de la semana, intervalo fijo o una sola vez — elija uno), instrucciones de tarea, ventana de tiempo activa y canales de notificación. Una corrección a una afirmación extendida: no existe un campo "fijar esta tarea a un modelo específico", por lo que el consejo de resincronizar los modelos de tarea programada después de cambiar de modelo no se aplica. La parte que determina la fiabilidad son las instrucciones de la tarea — porque nadie está presente para aclarar en tiempo de ejecución, la promesa debe llevar su propio objetivo, límites y formato de salida.**

---

## "Proactivo" no significa vigilarle permanentemente

"Dame un resumen de noticias cada mañana" suena como una instrucción ordinaria, pero se diferencia fundamentalmente de "dame un resumen de noticias ahora".

El segundo es una conversación: usted está presente, por lo que puede seguirlo, corregirlo y añadir contexto en cualquier momento. El primero es **trabajo que debe ejecutarse mientras usted está ausente**: nadie confirma que lo entendió correctamente, nadie lo detiene cuando la salida se desvía de la meta y nadie le dice dónde enviar los resultados para que realmente los vea.

Por lo tanto, la parte difícil de "proactivo" no es el disparo programado — eso es la parte fácil. La parte difícil es esta: **reescribir una conversación que dependió de su presencia en una orden de trabajo que tiene éxito sin ella.** Este artículo cubre qué contiene esa orden de trabajo y cómo escribir una que resista.

---

## 1. Lo que realmente contiene una tarea programada

Crear una tarea programada en LightVela implica estos campos.

| Campo | La pregunta que responde | Notas |
|---|---|---|
| **Nombre** | ¿Cómo se llama esta tarea? | Se usa para identificarla en la lista; nómbrala según la acción, no como "Tarea 1" |
| **Programación** | ¿Cuándo se ejecuta? | Días fijos de la semana, intervalo fijo o una sola vez — elija uno |
| **Instrucciones de tarea** | ¿Qué debe lograrse? | La promesa desde la cual el Agent trabaja en tiempo de ejecución |
| **Ventana de tiempo activa** | ¿Durante qué horas es válida? | Restringe cuándo puede ejecutarse la tarea; dejarla vacía significa alrededor de las 24 horas |
| **Canales de notificación** | ¿Dónde va el resultado? | Opciones de conmutador opcionales que seleccionan qué canales reciben avisos de ejecución |

**Un punto que vale la pena decir claramente: no existe un campo "modelo".** Una tarea programada no está fijada a un modelo específico, por lo que el consejo comúnmente repetido de que debe revisar y resincronizar el modelo de cada tarea programada después de cambiar de modelos no se aplica a esta forma de producto. Lo que vale la pena revisar después de un cambio de modelo es la **calidad de la salida**, no un campo que no existe. Para la capa de superposición detrás de esto, vea "¿Puede el cerebro de un Hermes Agent ser reemplazado? Capa de modelo vs Capa de Agent".

También note que la programación es una elección entre días fijos de la semana, intervalo fijo y una sola vez — no una expresión cron arbitraria. Saber esto de antemano le ahorrará diseñar una programación con forma de cron y luego descubrir que no hay ningún lugar para ingresarla.

---

## 2. Elegir entre los tres tipos de programación

Los tres modos sirven a tres necesidades diferentes, y elegir el incorrecto produce un comportamiento que no coincide con su expectativa.

**Días fijos de la semana** se adapta a trabajos vinculados a ritmos humanos o ciclos de trabajo — resumir el progreso de la semana pasada el lunes por la mañana, un recordatorio del domingo para regar las plantas. Su característica definitoria es que está **anclado a una hora específica**, lo que se ajusta a "Quiero ver esto en ese momento".

**Intervalo fijo** se adapta a trabajos donde el tiempo no importa, solo la frecuencia — verificar una fuente de información cada pocas horas. Su característica definitoria es que **cuenta desde la ejecución anterior**, lo que se ajusta a "Quiero que mantenga este ritmo".

**Una sola vez** se adapta a eventos únicos, como un recordatorio en una fecha específica. Termina después de ejecutarse, sin nada que desactivar después.

Una prueba simple al elegir: **¿su requisito menciona una hora del reloj?** Si es así, use días fijos de la semana. Si solo una frecuencia, use intervalo fijo. Si ocurre una vez, use una sola vez.

---

## 3. Para qué sirve la ventana de tiempo activa

Este campo es fácil de saltarse, pero resuelve una molestia real: **quiere que la tarea mantenga un ritmo, pero no que la perturbe durante ciertas horas.**

El caso clásico es una tarea de intervalo. Establecer "cada dos horas" sin ventana activa significa que se ejecuta alrededor de las 24 horas, incluyendo la noche. Con una ventana activa, solo se ejecuta durante las horas que especifique.

Dejarlo vacío significa operación continua. Por lo tanto, si una tarea se ejecutó en una hora en la que no debería, verifique este campo primero.

---

## 4. Lo que realmente ocurre cuando llega la hora

Es aquí donde ocurren los malentendidos más comunes. Muchas personas asumen que una tarea programada significa "reenviar su oración original al Agent", y ese supuesto lleva a promesas que se inclinan demasiado hacia el contexto.

Lo que realmente ocurre: cuando el programador alcanza la hora objetivo, **inicia una ejecución independiente del Agent**. Esa ejecución completa el trabajo desde las instrucciones de la tarea en lugar de reinterpretar la conversación en la que se creó la tarea.

Esto tiene una consecuencia importante: **las instrucciones de la tarea deben llevar su propio contexto.** El contexto que usted mantuvo en su mente al crear la tarea, o los detalles que discutiera anteriormente con el Agent, no se aplicarán necesariamente en tiempo de ejecución a menos que se escribieron en las instrucciones o ya se capturaron en la memoria a largo plazo.

Compare dos versiones:

- **Dependiente del contexto**: "Arme un resumen como acabas de hacer." — En tiempo de ejecución, "acabas de hacer" ya no existe.
- **Autónomo**: "Resuma el correo no leído de las últimas 24 horas, agrupado por remitente, máximo tres elementos por grupo, manteniendo solo los mensajes que requieren mi respuesta; salida una lista con viñetas con cada elemento en una línea."

La segunda se ejecuta confiablemente sin nadie presente, porque el objetivo, el alcance, los criterios de filtro y el formato de salida están todos dentro de ella.

---

## 5. Cómo escribir instrucciones de tarea que resistan

Dado el mecanismo anterior, las instrucciones de tarea confiables suelen contener cuatro partes.

**Primero, una acción objetivo explícita.** Establezca qué hacer, no qué "mantener bajo vigilancia". No puede juzgar si "mantener bajo vigilancia" se completó; puede juzgar si "resumir y listar" se completó.

**Segundo, límites de alcance explícitos.** Un rango de tiempo (últimas 24 horas), un límite de volumen (máximo tres por grupo), un filtro (solo aquellos que requieren mi respuesta). Sin límites, la misma tarea puede producir salidas muy diferentes los diferentes días.

**Tercero, un formato de salida explícito.** Lista o prosa, agrupada o plana, longitud máxima de cada elemento. Como usted no está presente, no puede decir "demasiado largo, acortarlo" en el momento.

**Cuarto, manejo de excepciones explícito.** Si nada coincide, ¿debe enviar "nada que manejar hoy" o permanecer en silencio? Sin esto, no puede distinguir "la tarea no se ejecutó" de "la tarea se ejecutó y no encontró nada".

El cuarto punto es el que más a menudo se omite, y afecta directamente su capacidad para juzgar si una tarea es saludable.

---

## 6. Un orden de despliegue recomendado

No trate "crear la tarea" como un solo paso. Este orden expone la mayoría de los problemas temprano.

1. **Verifique manualmente en el chat primero.** Envíe la promesa que planea usar directamente al Agent y verifique la salida. Esto ajusta la promesa sin programar de esa manera.
2. **Revise la promesa basándose en ese resultado.** Salida demasiado larga, alcance demasiado amplio, formato inestable — corrija todo aquí.
3. **Cree la tarea y establezca la programación.** Use la prueba en la sección 2 para elegir un modo.
4. **Confirme que los canales de notificación apunten a algún lugar donde realmente lee.** Los resultados entregados donde nunca los ve es equivalente a no tener resultados.
5. **Establezca una ventana de tiempo activa si es necesario.** Especialmente para tareas de intervalo, para evitar interrupciones nocturnas.
6. **Espera una ejecución real, luego revise el registro de ejecución.** Este es el paso crítico — **no trate "tarea creada" como terminado.** Un guardado exitoso significa que la configuración se guardó, no que la salida es correcta.
7. **Refine la promesa una vez más basándose en esa primera ejecución real.** La ejecución real puede diferir de la prueba manual, y esta segunda revisión suele entregar el mayor aumento de estabilidad.

El producto soporta ver detalles de tarea, editar, pausar y eliminar desde la lista de tareas, por lo que el paso 7 es barato. Si una tarea es temporalmente innecesaria, prefiera pausar en lugar de eliminar para que la configuración permanezca disponible para reutilización.

---

## 7. Síntomas comunes y dónde buscar

| Síntoma | Causa más probable | Acción sugerida |
|---|---|---|
| Nada ocurre en la hora programada | Tarea pausada, o la hora actual cae fuera de la ventana activa | Verifique el estado de la tarea y la ventana de tiempo activa |
| Se ejecutó pero no llegó el resultado | Canales de notificación no configurados, o entregando en algún lugar que no lee | Verifique la configuración de notificación |
| Longitud y formato de salida varían ampliamente | Las instrucciones carecen de límites de alcance y formato de salida | Añada los cuatro elementos de la sección 5 |
| Salida muy diferente de la prueba manual | Las instrucciones se basaron en el contexto de la conversación desde el momento de la creación | Reescriba como instrucciones autónomas |
| No se puede distinguir "no se ejecutó" de "no encontró nada" | Las instrucciones carecen de manejo de excepciones | Añada "envíe un mensaje incluso cuando no hay nada" |
| Perturbado durante la noche | Tarea de intervalo sin ventana de tiempo activa | Establezca una ventana de tiempo activa |

Un principio general al solucionar problemas: **separe primero "no se ejecutó" de "se ejecutó pero produjo lo incorrecto".** El primero apunta al estado de la tarea, ventana activa y configuración de notificación; el segundo apunta a las instrucciones mismas. Estas tienen rutas de resolución completamente diferentes, e investigarlas juntas desperdicia tiempo.

---

## 8. El enfoque de LightVela: trabajo proactivo configurable y revisable

Hermes soporta trabajo programado a nivel de mecanismo, pero mantener el tiempo de ejecución y la programación confiables se deja al operador. La dirección de LightVela es hacer de esto una capacidad de producto configurable y revisable:

- **Plantillas reducen el costo inicial** — cuando está en duda qué automatizar, comience desde una plantilla lista y ajústela.
- **Ciclo de vida de tarea manejable** — vea detalles, edite, pause o elimine después de la creación, sin necesidad de reconstruir una tarea para cambiar una condición.
- **Entrega seleccionable** — los canales de notificación son opciones de conmutador opcionales, por lo que los resultados aterrizan donde realmente los lee.
- **Desacoplado de otras capacidades** — las tareas programadas, modelos, Skills y almacenamiento en la nube se configuran independientemente, y cambiar de modelos no altera la configuración de tarea programada.
- **Fallas rastreables** — combine anomalías de ejecución con registros recientes en Diagnostics para localizar la causa.

---

## Puntos clave

- Una tarea programada es fundamentalmente una configuración guardada, repetible de cuándo ejecutar, qué hacer y dónde entregar.
- Los campos son: nombre, programación (días fijos de la semana / intervalo fijo / una sola vez), instrucciones de tarea, ventana de tiempo activa, canales de notificación.
- **No existe un campo "modelo"**, por lo que "resincronizar modelos de tarea programada después de cambiar" es inexacto; las programaciones tampoco son expresiones cron arbitrarias.
- El disparo inicia una **ejecución independiente**, no una reinterpreta de una conversación antigua, por lo que las instrucciones deben ser autónomas.
- Las instrucciones confiables contienen cuatro partes: acción objetivo, límites de alcance, formato de salida, manejo de excepciones.
- El paso de despliegue decisivo es el último: **espera una ejecución real y revise el registro**, en lugar de detenerse en "tarea creada".
