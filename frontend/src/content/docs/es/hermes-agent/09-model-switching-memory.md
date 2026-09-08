## Resumen

**Cambiar de modelo no hace que un Hermes Agent olvide a usted, porque el modelo, la personalidad y la memoria son tres capas almacenadas separadamente: el modelo se encarga del razonamiento y la generación, `SOUL.md` define los límites de rol y expresión, y `USER.md` junto con `MEMORY.md` (con `memories/`) guardan el perfil de usuario y los hechos entre sesiones. En LightVela, cambiar de modelo solo cambia el motor detrás de las respuestas subsiguientes — no borra la memoria, los archivos de almacenamiento en la nube, las Skills ni la configuración de tarea programada, y no mueve el historial de chat. Puede sentirse "diferente" de verdad después, pero eso proviene de la capacidad de seguir instrucciones, la compresión de contexto, la verbosidad y las tendencias de llamada de herramientas del nuevo modelo, no de una pérdida de datos. Hay exactamente una forma de distinguirlos: pregunte sobre un hecho que está seguro de que debería saber. Si responde, está viendo una diferencia de estilo; si no puede, entonces investigue la capa de memoria.**

---

## El texto cambió — ¿la memoria también lo hizo?

Después de cambiar de modelo, la experiencia más común es esta: el lenguaje cambió, la longitud cambió, y ya no trae a colación cosas que habíamos discutido antes.

La primera reacción de casi todo el mundo es "me olvidó". Esa reacción es natural — en la vida cotidiana, cuando alguien deja de referirse al historial compartido, sospechamos que se olvidó.

Sin embargo, dentro de un sistema de Agent, la analogía engaña. **"No mencionarlo" y "no saberlo" son cosas enteramente diferentes.** El primero es una estrategia de expresión; el segundo es falta de datos. Difieren en diagnóstico, costo de reparación y gravedad, y confundirlos significa pasar tiempo reparando un problema que no existe.

Este artículo separa definitivamente las dos cosas y le da una prueba accionable.

---

## 1. Cinco capas: qué se reemplaza, qué se mantiene

Primero, sea preciso sobre lo que realmente cambia el acto de "cambiar de modelo".

| Capa | Responsabilidad | Dónde reside | Después de cambiar |
|---|---|---|---|
| **Modelo** | Razonamiento, planificación, decisiones de llamada de herramientas, lenguaje | Configuración configurable | **Reemplazado** |
| **Personalidad** | Rol, tono, prioridades, límites conductuales | `SOUL.md` | Preservado |
| **Perfil de usuario** | Hábitos lingüísticos, ritmo, herramientas habituales, cosas a evitar | `USER.md` | Preservado |
| **Memoria** | Hechos entre sesiones, estado del proyecto, decisiones pasadas | `MEMORY.md`, `memories/` | Preservado |
| **Skills** | Procedimientos estándar activados por situaciones | `skills/` (cada `SKILL.md`) | Preservado |

El punto clave: **las cuatro capas restantes viven fuera del modelo**. Cuando se reemplaza el modelo, esos archivos y directorios permanecen exactamente donde estaban, y el nuevo modelo los lee y los aplica.

Es por esto que la documentación puede afirmar claramente que cambiar de modelo no borra la memoria de un Agent, los archivos de almacenamiento en la nube, las Skills ni la configuración de tarea programada — eso no es una característica protectora que alguien agregó, es una consecuencia natural del almacenamiento en capas. Para la división completa de tareas, vea "¿Puede el cerebro de un Hermes Agent ser reemplazado? Capa de Modelo vs Capa de Agent".

---

## 2. Entonces, ¿por qué se siente diferente de verdad?

Si los datos están intactos, ¿por qué cambia la experiencia? Porque **el mismo contexto, entregado a un modelo diferente, se reinterpreta.**

Los modelos difieren en estas dimensiones reales:

### 2.1 Seguimiento de instrucciones

Las restricciones en `SOUL.md` siguen ahí, pero un nuevo modelo puede aplicarlas con más holgura o con más estricticidad. Si escribiste "llevar con la conclusión", algunos modelos cumplen cada vez mientras que otros se construyen hacia ella en preguntas complejas.

**Aparece como**: la personalidad cambió. **En realidad**: las reglas no cambiaron; cambió el cumplimiento.

### 2.2 Compresión de contexto

Al componer una respuesta, el Agent decide cuánto fondo citar. Los modelos ponderan esto de manera diferente: algunos restan activamente "mencionaste X antes", otros asumen que lo sabes y van directo al punto.

**Aparece como**: se olvidó de lo que discutimos. **En realidad**: la recuperación funciona, simplemente no lo restó. Este es el caso más a menudo mal diagnosticado como amnesia.

### 2.3 Preferencia de verbosidad

Para la misma pregunta, la longitud de la respuesta puede diferir varias veces entre modelos.

**Aparece como**: se volvió más tonto, o se volvió prolijo. **En realidad**: una verbosidad por defecto diferente, ajustable mediante preferencias en `USER.md` o una solicitud explícita.

### 2.4 Tendencia de llamada de herramientas

Algunos modelos prefieren leer archivos o buscar antes de responder; otros se apoyan en el contexto existente.

**Aparece como**: dejó de usar herramientas. **En realidad**: un umbral diferente para invocarlas.

### 2.5 Estilo lingüístico

El lenguaje, las formas de tratamiento y el tono pueden cambiar todos.

**Aparece como**: se convirtió en otra persona. **En realidad**: la categoría más superficial y más inofensiva.

Vistos juntos, estos cinco comparten una característica: **todos son sobre *cómo lo expresa*, no *qué sabe*.** Es precisamente sobre lo que se basa la prueba de abajo.

---

## 3. Una acción lo aclara: pregunte sobre un hecho conocido

No juzgue por la sensación. Use una prueba determinista.

**Método**: piense en un hecho que está **seguro** de que le dijo explícitamente y que ya debería estar en la memoria a largo plazo — un nombre de proyecto, su preferencia de idioma, una restricción explícita. Después de cambiar, pregunte exactamente eso.

**Interpretación**:

| Resultado | Conclusión | Siguiente paso |
|---|---|---|
| Respuesta correcta | Capa de memoria intacta; está viendo diferencias de estilo | Ajuste preferencias o prompts; deje la memoria sola |
| No puede responder pero dice que está incierto | Posiblemente un fallo de recuperación | Reformule y pregunte de nuevo para separar recuperación de ausencia |
| Respuesta incorrecta o inventa algo | El contenido de la memoria mismo necesita revisión | Inspeccione si la entrada existe o está obsoleta |

La prueba funciona porque elimina la variable de expresión: está preguntando sobre un hecho con una respuesta definitiva, así que independientemente de cómo cambió el estilo, la corrección es objetiva.

---

## 4. Una lista completa de verificación post-cambio

Este orden cubre la gran mayoría de los casos.

1. **Confirme que el cambio tomó efecto** — la consola debería mostrar el modelo que seleccionó. Esto descarta "pensé que cambié pero no lo hice".
2. **Envíe un mensaje de prueba corto** — confirme que el nuevo modelo responde normalmente. Si la primera respuesta después del cambio es ligeramente lenta, espere y repita una vez antes de cambiar algo más.
3. **Ejecute la prueba de hecho conocido** — verifique la capa de memoria usando la sección 3.
4. **Verifique que la personalidad siga coincidir con las expectativas** — observe si el tono y los límites permanecen dentro de `SOUL.md`. Si la deriva es obvia, haga que las restricciones clave sean más específicas.
5. **Verifique puntualmente que una Skill aún se active** — intente una en su situación correspondiente y confirme que la Skill se carga.
6. **Revise la calidad de la salida de tarea programada** — note que está revisando **calidad de salida**, no sincronizando un campo de modelo. Las tareas programadas no tienen configuración de "modelo fijo".
7. **Confirme que los archivos de almacenamiento en la nube están intactos** — cambiar no los reescribe; esto es solo verificación.

El paso 6 merece énfasis, porque una afirmación ampliamente circulada dice que debe desincronizar el modelo de cada tarea programada después de cambiar. En realidad, una tarea programada consiste en nombre, horario (días fijos de la semana, intervalo fijo o una sola vez), instrucciones de tarea, ventana de tiempo activa y canales de notificación — **sin campo de modelo**. Así que la acción correcta es esperar una ejecución real y verificar si la calidad de la salida sigue cumpliendo las expectativas.

---

## 5. Si realmente deja de funcionar después de cambiar

Esto es una clase diferente de problema — no "se siente diferente" sino "no funciona". Solucione en este orden:

1. **Confirme que la configuración del modelo está completa** — vuelva a la configuración del modelo y verifique el modelo objetivo, credenciales y configuraciones del proveedor.
2. **Confirme la disponibilidad de la cuenta y el cupo** — verifique que el modelo esté disponible para su cuenta y que el cupo o saldo del proveedor sea suficiente.
3. **Pruebe con un modelo conocido que funciona** — esto separa "este modelo tiene un problema" de "la ruta entera tiene un problema".
4. **Revise los registros recientes en Diagnostics** — si aún no puede responder, use los registros para determinar si el problema radica en el modelo, la configuración o la tarea, y luego decida si reiniciar la configuración del modelo.

Un principio general vale la pena recordar: **cambie un factor a la vez y pruebe después de cada cambio**. Cambiar el modelo, editar la personalidad y agregar una Skill a la vez deja que no pueda atribuir un fallo. Durante la solución de problemas, esta disciplina vale mucho más que la sensación de configurar todo en una pasada.

---

## 6. Cuando cambiar vale la pena y cuándo no

Cambiar tiene un costo: se re-adapta a un estilo de expresión diferente y puede necesitar retunear prompts. Así que vale la pena ser claro sobre la motivación.

**Vale cambiar**:

| Necesidad | Enfoque recomendado |
|---|---|
| Bocetos más rápidos | Elija un modelo configurado adecuado para trabajo corto y rutinario |
| Razonamiento más fuerte o ayuda de codificación | Elija el modelo que configuró para ese tipo de trabajo |
| Un proveedor no está disponible o tiene límites de tasa | Cambie a otro modelo configurado y pruebe en chat |
| Comparar calidad de salida | Use **el mismo** mensaje de prueba después de cada cambio, luego compare |

**No vale cambiar**:

- Porque una respuesta le decepcionó. Primero verifique si el prompt fue lo suficientemente específico, o si las restricciones de `SOUL.md` fueron lo suficientemente concretas.
- Porque escuchó que otro modelo es más fuerte. Más fuerte no es lo mismo que mejor adaptado a su mezcla de tareas y perfil de costos.
- Para "corregir un problema de memoria". Los problemas de memoria no se pueden resolver en la capa de modelo; inspeccione las entradas de memoria en su lugar.

La frase "el mismo mensaje de prueba" en la cuarta fila importa: si compara modelos usando preguntas diferentes cada vez, está midiendo la dificultad de la pregunta, no la diferencia del modelo.

---

## 7. El enfoque de LightVela: hacer que el cambio sea una operación de bajo riesgo

Hermes logra la separación de capas en el nivel de mecanismo, pero la gestión del acceso al modelo y el entorno sigue siendo responsabilidad del operador. La dirección de LightVela es hacer que el cambio sea una operación rutinaria, de bajo riesgo y verificable:

- **Un Agent tiene un modelo activo a la vez** — cambiar significa seleccionar, sin necesidad de un Agent separado por modelo.
- **Los activos se mantienen estables entre cambios** — la memoria, los archivos de almacenamiento en la nube, las Skills y la configuración de tarea programada no se ven afectadas, y el historial de chat no se mueve.
- **Los cambios son verificables** — la consola muestra el modelo activo, y un mensaje de prueba confirma el éxito.
- **Los fallos son localizables** — Diagnostics mantiene registros recientes para separar problemas de modelo, configuración y tarea.
- **Se fomentan cambios de un solo factor** — cambiar una cosa a la vez y probar inmediatamente es la recomendación documentada.

---

## Puntos clave

- Modelo, personalidad, perfil de usuario, memoria y Skills son cinco capas independientes; el cambio reemplaza solo la primera.
- Comportamiento documentado: cambiar no borra memoria, almacenamiento en la nube, Skills ni tareas programadas, y no mueve el historial de chat.
- "Se siente diferente" proviene de cinco diferencias de capa de expresión: seguimiento de instrucciones, compresión de contexto, verbosidad, tendencia de llamada de herramientas, estilo lingüístico.
- **Determinar una pérdida real de memoria toma un paso**: pregunte sobre un hecho conocido definitivo.
- Las tareas programadas no tienen campo de modelo fijo; después de cambiar, revise la calidad de la salida en lugar de buscar ese campo.
- Durante la solución de problemas, manténgase a una regla: cambie un factor a la vez y pruebe inmediatamente.
