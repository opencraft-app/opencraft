## Resumen

**Un Agent mejora con el uso no porque se actualice misteriosamente en el fondo, sino porque dos tipos de cosas se retienen de manera estructurada: los hechos estables se convierten en Memoria, y los métodos reutilizables se capturan como Skills, para luego recargarse cuando la situación coincide. La Memoria le permite saber qué pasó —recordado cuando una consulta coincide. Las Skills le permiten saber qué hacer la próxima vez —cargado cuando una situación coincide. Sus disparadores, formas y tasas de cambio son todas diferentes, por lo que no pueden fusionarse. Hermes proporciona `/learn` para que el Agent destile un procedimiento probado desde la sesión actual en un `SKILL.md`, con `/skills pending` para revisión, de modo que la mejora propia nunca se convierta en una modificación propia sin límites. Una Skill sólida debe declarar cuatro cosas: cuándo usarla, qué pasos seguir, qué aspecto tiene el éxito y qué límites no deben cruzarse. Lo que importa no es cuánto capturas, sino que permanezca revisable, reutilizable y actualizable cuando el producto cambia.**

---

## La experiencia que no se puede reutilizar es simplemente una conversación

Piense en una sesión que salió excepcionalmente bien. Usted y su Agent depuraron un problema juntos, o produjeron un conjunto genuinamente bueno de notas de lanzamiento. A lo largo del camino, lo corrigió tres o cuatro veces: estreche el alcance, mantenga el formato consistente, nunca omita esa comprobación específica. El resultado fue sólido.

Una semana después, llega la misma clase de tarea. Si esas correcciones viven solo en el registro de chat de la semana pasada, notará que dice las mismas cosas de nuevo — **el ajuste nunca se convirtió en un activo, solo en un gasto único.**

Esa es la pregunta real detrás de "mejora con el uso". No se trata del Agent volviéndose misteriosamente más inteligente. Se trata de **qué ya ha sido probado y retenido en una forma estructurada**. Lo que usted mantiene, cómo lo mantiene y dónde vive determinan si la acumulación es real o si cada sesión comienza de cero.

---

## 1. Dos tipos de acumulación, no que se confundan

Un Agent acumula dos cosas fundamentalmente diferentes.

| Acumulación | Qué almacena | Cómo se usa | Tasa de cambio |
|---|---|---|---|
| **Memoria** | Hechos, preferencias, conclusiones, historia | Recordado cuando es relevante para la pregunta actual | Alta; las entradas pueden agregarse en varias sesiones |
| **Skill** | Situaciones, pasos, límites, comprobaciones | Cargado y ejecutado cuando una situación coincide | Baja; puede permanecer sin cambios durante meses |

Un par de ejemplos coincidentes:

- "Este usuario prefiere la conclusión primero" → **Memoria**. Es un hecho sobre usted.
- "Antes de escribir notas de lanzamiento, verifique el número de versión y que cada enlace se resuelva" → **Skill**. Es un procedimiento para ejecutar cada vez que aparezca ese tipo de tarea.

No pueden fusionarse, por al menos tres razones: **disparadores diferentes** (coincidencia de consulta vs coincidencia de situación), **formas diferentes** (entradas cortas vs pasos ordenados) y **tasas de cambio diferentes** (diario vs mensual). Mezclar un procedimiento estable en una lista de hechos de alta rotación lava la parte estable. Para el argumento completo, vea "La Memoria No es una Skill: Cómo el Agent Hermes Separa la Memoria Factual y Procedimental".

Esta distinción tiene un beneficio práctico inmediato: **cuando usted se da cuenta de que está corrigiendo el mismo tipo de comportamiento repetidamente, lo que necesita es una Skill, no otro hecho en la memoria.**

---

## 2. Qué se ve una Skill

En Hermes, una Skill es típicamente un `SKILL.md` con frontmatter de YAML que declara su disparador y detalles de soporte. Aproximadamente:

```yaml
---
name: release-note-format
trigger:
  when: "user asks to write release notes"
---

# Standard procedure for release notes

1. Confirm the version number and release date
2. Group entries as Added / Fixed / Changed
3. Verify every external link resolves
4. Check for internal project names or ports; replace with placeholders
5. Confirm length fits the publishing channel's limits
```

El `trigger` es lo que importa: significa que no invoca la Skill manualmente. Cuando se reconoce una situación coincidente, la Skill se carga automáticamente como una instrucción de alta prioridad que guía esa ejecución.

Hermes añade dos capas de organización:

- **Paquete de Skills** — empaquete Skills relacionadas para habilitar, deshabilitar o compartir como un grupo. Un paquete de "tubería de lanzamiento" podría contener comprobaciones previas al lanzamiento, formato de changelog y pasos de reversión.
- **`fallback_for_toolsets`** — una Skill puede declararse como la alternativa cuando una llamada de conjunto de herramientas falla, de modo que los caminos de fallo también tienen un procedimiento definido.

Juntos, esto convierte a las Skills en SOPs aislados en una metodología de trabajo componible.

---

## 3. `/learn`: convertir una ejecución exitosa en un método

Capturar una Skill no requiere salir de la conversación para escribir archivos. Hermes proporciona `/learn`, lo que permite al Agent destilar un procedimiento digno de conservarse desde la sesión actual en un nuevo `SKILL.md`.

El valor de este diseño es que **la captura ocurre mientras la memoria es más fresca**. Justo después de una colaboración exitosa, tanto usted como el Agent saben qué pasos importaron y qué corrección fue esencial. Escríbalo una semana después y los detalles ya se han perdido.

Pero la destilación automática crea un problema que debe abordarse: **si un Agent puede agregar reglas de comportamiento a sí mismo a su antojo, su comportamiento se vuelve impredecible**. Hermes maneja esto con un paso de revisión —inspeccione Skills pendientes mediante `/skills pending` y decida si adoptarlas. Esto refleja `/memory pending` en el lado de la memoria.

**La mejora propia no es una modificación propia sin límites.** El camino confiable es que un nuevo método primero se convierta en una **regla revisable**, tomando efecto solo después de la confirmación. Es lo que hace que el crecimiento de capacidad sea explicable, reutilizable y correctable.

---

## 4. Cuatro cosas que una Skill sólida debe declarar

Esto es lo que separa a una Skill útil de una dañina. Omita cualquiera de las cuatro y la Skill fallará en la práctica.

**Primero, cuándo usarla.** Las situaciones de disparo deben ser específicas. "Al manejar documentos" es demasiado amplio y se cargará en contextos donde no pertenece; "cuando el usuario pide notas de lanzamiento" es lo suficientemente específico. Una Skill demasiado amplia es peor que no tener Skill, porque interfiere con tareas no relacionadas.

**Segundo, qué pasos seguir.** Los pasos deben estar ordenados y ejecutables. "Preste atención a la calidad" no es un paso; "verifique que cada enlace externo se resuelva" sí lo es. La prueba: ¿podría otra persona seguir esta Skill y producir un resultado consistentemente amplio?

**Tercero, qué aspecto tiene el éxito.** Sin un criterio de éxito, el Agent no puede auto-comprobarse y usted no puede juzgar si una ejecución fue aceptable. Hágalo verificable, por ejemplo "los tres grupos presentes, cada uno con al menos una entrada o una nota explícita de que el grupo está vacío".

**Cuarto, qué límites no deben cruzarse.** Declare prohibiciones explícitamente, como "no nombres de proyectos internos reales ni puertos en los ejemplos". Los límites son la parte más frecuentemente omitida de una Skill y la fuente más común de incidentes.

Las Skills con las cuatro cosas comparten una característica: **se leen igual de bien a los humanos y al Agent**. Porque usted puede entender qué hace, puede corregirla precisamente cuando va mal —lo cual es la condición previa para ser correctable en absoluto.

---

## 5. Tres etapas que hacen que la acumulación rinda

La captura no es una acción única; es un proceso ordenado. Omitir una etapa reduce la calidad.

**Primera etapa: pruebe el procedimiento en trabajo real primero.** No escriba Skills desde la imaginación. Un procedimiento que nunca se ejecute contra una tarea real solo cementará errores cuando se capture. Hágalo una vez y note las correcciones a lo largo del camino.

**Segunda etapa: capture pasos que son estables y reutilizables.** Note ambos calificadores — **estable** (no cambiará la próxima semana) y **reutilizable** (se aplica más allá de este caso de borde único). Un procedimiento único no vale la pena capturarlo; el mantenimiento costará más de lo que devuelve.

**Tercera etapa: actualice Skills cuando el producto, las herramientas o las políticas cambien.** Esta es la etapa más frecuentemente omitida. Una Skill escrita hace seis meses que referencia un punto de entrada movido o un límite ajustado desde entonces seguirá emitiendo orientación obsoleta. **Reutilizar indefinidamente experiencia obsoleta es más peligroso que no tener ninguna**, porque lleva la credibilidad de haber sido "probado".

Un hábito de mantenimiento práctico: cuando usted se da cuenta de que está corrigiendo repetidamente la salida de una Skill a mano, esta ha caducado. Actualícela en lugar de trabajar alrededor de ella.

---

## 6. Errores comunes

| Error común | El problema | Haga esto en su lugar |
|---|---|---|
| Almacenar reglas de comportamiento como entradas de Memoria | Puede no ser recordado en una consulta fallida, y se lava por entradas posteriores | Reglas a `SOUL.md`, procedimientos a Skills |
| Escribir disparos amplios "para cubrir más" | Se carga durante tareas no relacionadas e interfiere | Estreche a una situación específica |
| Pasos sin límites | Los pasos se ejecutan correctamente pero pueden filtrar detalles internos o exceder límites | Añada prohibiciones explícitas |
| Capturar muchas Skills pero nunca recortar | Skills expiradas siguen emitiendo orientación incorrecta | Revise periódicamente; actualice al cambiar |
| Esperar mejora autónoma sin revisión | El comportamiento se vuelve impredecible y difícil de diagnosticar | Adopte mediante `/skills pending` |
| Capturar procedimientos únicos | El costo de mantenimiento supera el beneficio | Capture solo procedimientos estables y reutilizables |

La cuarta fila merece énfasis: **el valor de una biblioteca de Skills no es proporcional a su tamaño**. Una Skill expirada puede costar más que diez buenas devueltas, porque se carga automáticamente y parece creíble.

---

## 7. El enfoque de LightVela: métodos como activos de usuario también

Hermes ha hecho que la separación Memoria/Skill sea lista para ingeniería, pero aún apunta a personas editando Markdown directamente. LightVela ejecuta un modelo alojado en la nube y no expone operaciones de sistema de archivos para usuarios, por lo que los dos tipos de acumulación funcionan así:

- **Las Skills provienen de mercados públicos** — cada Skill proviene de Skills.sh y ClawHub, los mercados de Skills compartidos por OpenClaw y Hermes, por lo que no las escribe desde cero.
- **Instalar y eliminar mediante conversación** — le diga a Hermes qué Skill instalar y lo maneja; la eliminación funciona de la misma manera. Verifique la disponibilidad en el chat después. La instalación desde el panel de consola llegará pronto.
- **La Memoria es visible en la consola** — la página de memoria muestra lo que el Agent ha retenido y le permite ajustar el límite de capacidad; las adiciones y eliminaciones ocurren mediante conversación.
- **Estable a través de modelos y canales** — cambiar modelos no elimina Skills ni tareas programadas, y cada canal conectado comparte las mismas Skills y memoria.
- **Los fallos son rastreables** — cuando una Skill se comporta mal, vea y exporte registros recientes en Diagnóstico (seleccionable rangos de 1, 3, 6, 12 o 24 horas) para localizar el problema.

En otras palabras, usar un Agent en LightVela significa acumular dos cosas: una Memoria sobre usted, y un conjunto de Skills instaladas y verificadas. **Ambas le sirven más tiempo que cualquier modelo particular.**

---

## Puntos clave

- Mejorar con el uso proviene de la acumulación estructurada, no de una mejora propia misteriosa.
- Dos tipos deben mantenerse distintos: **Memoria** almacena hechos (recordado en coincidencia de consulta), **Skills** almacenan métodos (cargado en coincidencia de situación).
- Cuando usted mantiene corrigiendo el mismo comportamiento, capture una Skill en lugar de agregar otro hecho.
- `/learn` captura métodos mientras los detalles son frescos; `/skills pending` proporciona revisión, de modo que **la mejora propia no es una modificación propia sin límites**.
- Una Skill sólida declara cuatro cosas: **cuándo usarla, los pasos, el criterio de éxito y los límites**.
- La captura se ejecuta en tres etapas: pruebe en trabajo real → capture pasos estables y reutilizables → actualice al cambiar. **Una Skill expirada es más peligrosa que ninguna.**
