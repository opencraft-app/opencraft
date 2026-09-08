## Resumen

**La personalidad de un Hermes Agent no es un bloque fijo de copias de personaje. Surge de tres piezas trabajando juntas: `SOUL.md` establece quiénes es y cómo funciona — reglas de comportamiento estables; `USER.md` registra cómo quieres que te traten — los defectos de la relación; `MEMORY.md` y `memories/` guardan lo que ya han establecido los dos — evidencia de historia compartida. Mantener sus roles distintos es lo que permite que un Agent sea estable e individual al mismo tiempo: la sola personalidad lo hace idéntico para todos, la sola memoria hace que su comportamiento se deslice de manera impredecible. No deben sustituirse entre sí — una personalidad no almacena hechos específicos, `USER.md` no almacena estados de ánimo puntuales, y `MEMORY.md` no lleva reglas de comportamiento. Las tres permanecen en su lugar cuando cambias de modelo, por lo que la estabilidad de la personalidad no depende de ningún modelo en particular.**

---

## ¿Por qué el mismo personaje debe comportarse de manera diferente con diferentes personas

Imagina dos usuarios que ambos configuraron su Agent como "un asistente de investigación paciente".

El primero es un gerente de producto que prefiere la conclusión antes del razonamiento y discute principalmente el ritmo de lanzamiento y las prioridades. El segundo es un estudiante que necesita la derivación completa y discute principalmente conceptos y tareas.

Si ambos Agents dijeran exactamente las mismas cosas, entonces "asistente de investigación paciente" nunca realmente aterrizó — se quedó como una etiqueta en lugar de convertirse en una manera concreta de trabajar juntos.

Por el contrario, si la personalización significaba permitir que el comportamiento se deslize libremente en cada conversación, el Agent perdería la predictibilidad: riguroso hoy, descuidado mañana. No podrías confiar en ello.

**La personalidad debe satisfacer dos requisitos contradictorios al mismo tiempo: ser estable y ser específico de la persona.** Hermes resuelve esto dividiendo los dos requisitos entre capas, cada una llevada por un archivo diferente.

---

## 1. Tres piezas, tres responsabilidades

Comencemos con el panorama general.

| Pieza | ¿Dónde reside? | La pregunta que responde | Frecuencia de cambio |
|---|---|---|---|
| **Personalidad** | `SOUL.md` | ¿Quién soy? ¿Qué principios trabajo por? | Muy baja; las ediciones son decisiones deliberadas |
| **Preferencias del usuario** | `USER.md` | ¿Cómo quieres que te traten? | Baja; se ajusta con hábitos a largo plazo |
| **Memoria a largo plazo** | `MEMORY.md`, `memories/` | ¿Qué ya hemos establecido? | Alta; las entradas pueden agregarse en muchas sesiones |

Esa **diferencia en frecuencia de cambio** es una de las razones fundamentales para mantenerlos separados. Poner un manual de reglas que se mantiene quieto durante meses en el mismo archivo que una lista de hechos que crece diariamente significa que la parte estable se lava con la volátil. Esto es el mismo razonamiento detrás de mantener `USER.md` y `MEMORY.md` separados — véase "¿Por qué Hermes Agent divide la memoria en dos: Los roles de USER.md y MEMORY.md."

---

## 2. Personalidad: reglas de comportamiento estables

`SOUL.md` es el manual de reglas del Agent, y típicamente cubre:

- **Rol** — lo que desempeña: asistente de investigación, compañero de escritura, asistente de deberes comunitarios.
- **Tono y expresión** — formal o relajado, si usar analogías, si el humor es bienvenido.
- **Orden de prioridad** — cuál gana cuando la precisión entra en conflicto con la velocidad, o la brevedad con la completitud.
- **Límites de comportamiento** — lo que no hará, lo que no expandirá, qué acciones requieren confirmación primero.

Tres puntos prácticos al escribir una personalidad.

**Primero, escribe principios, no hechos.** "Trabajo para un gerente de producto en el proyecto agent-demo" no pertenece en `SOUL.md` — eso es un hecho, y pertenece en `USER.md` o en la memoria. Una personalidad debe declarar principios duraderos como "para preguntas de producto, da la conclusión antes del razonamiento".

**Segundo, haz que los límites sean lo suficientemente concretos para juzgar.** "Mantente profesional" no puede evaluarse por cumplimiento. "No ofrezca decisiones médicas, legales o de inversión; proporcione información pública y sugiera consultar a un profesional" sí puede. Las reglas abstractas producen una adhesión muy diferente entre modelos.

**Tercero, declara la prioridad explícitamente para conflictos.** Las reglas inevitablemente entran en conflicto — la brevedad y la completitud son un par de ellos. Sin un ordenamiento explícito, el Agent tiene que adivinar cada vez, y su comportamiento se vuelve inconsistente.

---

## 3. Preferencias del usuario: los defectos de la relación

`USER.md` lleva **información estable sobre ti**, por lo que el Agent no tiene que preguntar cada vez. Buenos candidatos:

- **Idioma y expresión** — qué idioma, si mantener la terminología en su forma original, si los ejemplos ayudan.
- **Ritmo de comunicación** — conclusión primero, o la ruta de razonamiento completa.
- **Herramientas y entorno habituales** — la pila, plataformas y estilo de trabajo que usas diariamente.
- **Cosas explícitas a evitar** — direcciones que no quieres que se investiguen, frases que no quieres que se usen.

Existe una prueba simple para saber si algo pertenece en `USER.md`: **¿seguirá siendo verdadero en tres meses?** "Prefiero respuestas concisas" probablemente sí, por lo que encaja. "Estoy apurado hoy" no lo será — eso es contexto puntual y debería quedarse fuera.

Esta prueba importa. Escribir un estado de ánimo puntual en `USER.md` hace que el Agent trate un estado temporal como permanente. Si una vez dijiste "mántelo corto" mientras te apurabas y eso se endurece en una preferencia a largo plazo, omitirá detalles más tarde cuando realmente los necesites.

---

## 4. Memoria a largo plazo: evidencia de historia compartida

`MEMORY.md` y `memories/` almacenan **hechos que ya ocurrieron y valen la pena guardar**: estado del proyecto, decisiones tomadas, conclusiones reutilizables, por qué un parámetro se establece de esa manera.

Su relación con los otros dos:

- La personalidad determina **principios de comportamiento**.
- `USER.md` determina **estilo de interacción por defecto**.
- La memoria determina **el fondo que ambos compartes**.

El recuerdo es a demanda: Hermes construye un índice completo de texto SQLite + FTS5 sobre las entradas y extrae las que coinciden al contexto cuando levantas un tema relacionado, en lugar de empujar toda la historia. La escritura no es una concatenación ilimitada tampoco — se mantiene mediante operaciones atómicas `add` / `replace` / `remove` y puede revisarse mediante `/memory pending`. Para la lógica de curación completa, véase "¿Por qué más memoria no es mejor: Cómo Hermes Agent selecciona, curan y actualiza la memoria a largo plazo."

**La memoria no debe sustituir a la personalidad.** Un error común es escribir una regla de comportamiento como una entrada de memoria, como "recordar: siempre da la conclusión primero". Eso crea dos problemas: la entrada puede no ser recordada si la consulta no coincide, y puede ser lavada por entradas posteriores. Las reglas de comportamiento pertenecen en `SOUL.md`, que siempre reside.

---

## 5. Cómo las tres se combinan para producir una respuesta

Un escenario concreto que une las capas.

**Configuración**:

- `SOUL.md`: asistente de investigación; conclusión antes del razonamiento; banderé la incertidumbre explícitamente; no expanda sobre consejos médicos o de inversión.
- `USER.md`: prefiere inglés; mantenga términos técnicos en su forma original; mantenga las respuestas escaneables.
- `MEMORY.md`: actualmente trabajando en el sitio global para el proyecto agent-demo; la semana pasada decidió cambiar la página de inicio a un degradado animado; el proyecto se ejecuta en Next.js.

**Tu pregunta**: "Para el enfoque de la página de inicio actual, ¿cuáles son los riesgos de agregar un fondo de video?"

**Lo que contribuye cada capa**:

1. **Memoria** provee el fondo: el Agent sabe a qué página se refiere "la página de inicio" y que fue cambiada recientemente a un degradado animado, por lo que puede tratar un fondo de video como un cambio encima de eso en lugar de una decisión desde cero.
2. **Personalidad** determina la estructura: conclusión primero ("los riesgos principales son el rendimiento sobre el pliegue superior y el uso de datos móviles"), luego el razonamiento, con la incertidumbre banderada explícitamente.
3. **`USER.md`** determina la expresión: respuesta en inglés, mantenga términos como `LCP` y `autoplay` como están, y mantenga la longitud escaneable.

Quita cualquier capa y el resultado se degrada visiblemente: sin memoria la respuesta se queda genérica; sin la personalidad la estructura se desvía y la incertidumbre no se bandera; sin preferencias el idioma y la longitud no se ajustan a cómo lees.

---

## 6. Síntomas comunes y a dónde pertenece cada uno

En la práctica, la pregunta más frecuente es "¿dónde debería ir esta pieza de información?". La tabla de abajo responde.

| Síntoma | Causa más probable | ¿Qué cambiar? |
|---|---|---|
| Enfoque genérico para cada tema | La memoria carece de tu fondo específico | Agrega entradas de memoria |
| Comportamiento inconsistente, riguroso luego descuidado | Las reglas de personalidad son demasiado abstractas, o no hay prioridad de conflicto | Edita `SOUL.md` para que las reglas sean juzgables |
| Restas las preferencias cada vez | Las preferencias nunca se escribieron en `USER.md` | Agrega a `USER.md` |
| Trata un estado temporal como permanente | El contexto puntual se escribió en `USER.md` | Elimina esa entrada; estípalo en la conversación |
| Una regla aplica a veces pero no siempre | La regla se almacenó como una entrada de memoria | Muevela de memoria a `SOUL.md` |
| Tono cambia notablemente después de cambiar de modelo | El nuevo modelo aplica reglas con diferentes estrictas | Haz que las restricciones clave sean más específicas; deja la memoria sola |

La última fila merece énfasis: **un cambio de tono después de cambiar de modelo no es una personalidad perdida**. `SOUL.md` sigue donde estaba; cambió la adhesión. Para saber cómo distinguir, véase "¿Cambiar de Modelo Hace que un Agent Olvide? Desacoplando Modelo, Personalidad y Memoria."

---

## 7. El enfoque de LightVela: personalidad y preferencias como activos manejables

Hermes separa claramente estas tres capas, pero aún apunta a personas editando Markdown directamente. LightVela ejecuta un modelo alojado en la nube y no expone operaciones de sistema de archivos para usuarios, por lo que estas capas se mantienen de manera diferente que en una configuración auto-hospedada:

- **La personalidad se configura a través de la función Persona** — la sección de Persona en la página de configuración de un Agent ofrece dos puntos de entrada, dibujando una personalidad al azar o respondiendo un cuestionario breve. Revisa el rol, tono y notas de comportamiento de una tarjeta de personalidad, luego elige Inyectar Personalidad para aplicarla. Genera e inyecta el Alma sin requerir que toques el sistema de archivos en la nube, aunque no es un editor de propósito general para archivos arbitrarios en la nube.
- **La memoria es visible en la consola** — la página de memoria muestra lo que el Agent ha retenido, con pestañas separadas para Memoria y Perfil de Usuario, coincidiendo con la división entre hechos y preferencias estables.
- **Las adiciones y remociones ocurren a través de la conversación** — no necesitas deliberadamente "llenar" la memoria. Durante la conversación normal Hermes decide qué vale la pena retener; cuando quieres que recuerde u olvide algo, solo di eso en el chat.
- **La capacidad es ajustable** — la consola te permite aumentar o disminuir el límite de capacidad de memoria, previniendo que el contexto a largo plazo crezca sin límites.
- **Estable a través de modelos** — cambiar de modelo no borra la memoria, las Skills o tareas programadas, por lo que la estabilidad de la personalidad no depende de un modelo específico.
- **Consistente a través de canales** — un Agent comparte la misma memoria y personalidad en cada canal conectado; cambiar teléfonos o canales no lo pierde, y nada necesita duplicarse por plataforma.

---

## Puntos clave

- La personalidad surge de tres piezas: `SOUL.md` (reglas de comportamiento), `USER.md` (estilo de interacción por defecto), `MEMORY.md` / `memories/` (fondo compartido).
- La razón fundamental para separarlos es **frecuencia de cambio diferente**: las reglas se mantienen quietas durante meses, la memoria crece casi diariamente.
- Las personalidades declaran principios en lugar de hechos, mantienen límites lo suficientemente concretos para juzgar y declaran prioridad para reglas en conflicto.
- Prueba para membresía en `USER.md`: **¿seguirá siendo verdadero en tres meses?**
- No almacenes reglas de comportamiento como entradas de memoria, o fallarán intermitentemente a través de fallos de recuerdo o siendo lavadas.
- Un cambio de tono después de cambiar de modelo refleja una adhesión diferente, no una personalidad o memoria perdida.
