## Resumen

`USER.md` y `MEMORY.md` son los dos cuadernos personales detrás de la memoria a largo plazo de Hermes Agent, y tres restricciones estrictas explican por qué no pueden fusionarse. Primero, la capacidad es independiente (`USER.md` tiene aproximadamente 1,375 caracteres / 500 tokens; `MEMORY.md` tiene aproximadamente 2,200 caracteres / 800 tokens), por lo que ninguno aprieta al otro. Segundo, las semánticas de carga difieren: ambos se cargan en cada sesión, pero sus roles son completamente diferentes — uno describe de forma estable "quiénes eres", mientras que el otro registra con frecuencia "qué hemos hecho". Tercero, las semánticas de actualización difieren: los campos de preferencia en `USER.md` sobrescrien mayormente los valores antiguos, mientras que `MEMORY.md` mayormente agrega y consolida bajo demanda. Fusionarlos en un único archivo `NOTES.md` rompería las tres restricciones a la vez — un caso de texto clásico de "parece más simple, funciona peor".

---

## Una pregunta justa para empezar

A través de la memoria en capas de Hermes, `USER.md` y `MEMORY.md` suman solo **~3,575 caracteres / ~1,300 tokens** — notablemente restringidos en una era de ventanas de contexto de seis cifras.

Por lo tanto, la primera reacción de la mayoría de la gente son tres preguntas:

- ¿Por qué no fusionarlos en un único `NOTES.md`?
- ¿Por qué no escalar a decenas de kilobytes?
- ¿Por qué los dos archivos tienen incluso diferentes techos (2,200 vs 1,375)?

Las tres apuntan a la misma respuesta: **`USER.md` y `MEMORY.md` son dos tipos diferentes de memoria, y empaquetarlos juntos hace que ambos empeoren**. A continuación, ese principio de diseño se descompone en tres capas.

---

## 1. `USER.md`: una descripción de usuario estable y estructurada

`USER.md` es una **descripción estable de ti**:

- Identidad: nombre, rol, ubicación.
- Preferencias: estilo de comunicación, pila tecnológica habitual.
- Restricciones: horario, idioma, temas a evitar.
- Estilo de trabajo: conclusiones primero o proceso primero.
- Objetivos a largo plazo: hacia qué estás trabajando.

Sus **características clave**:

- **Estable**: actualizado una vez cada pocos días o semanas.
- **Estructurado**: seccionado, itemizado, basado en campos.
- **Siempre cargado**: inyectado en el prompt del sistema al inicio de cada sesión.
- **Techo duro**: ~1,375 caracteres / ~500 tokens.

Piensa en `USER.md` como **la nota adhesiva en la bisel del monitor del Agent** — no mucho en ella, pero siempre a la vista y siempre útil.

---

## 2. `MEMORY.md`: un archivo factual en crecimiento y bajo demanda

`MEMORY.md` almacena **lo que tú y el Agent han hecho juntos**:

- Estado del proyecto: el Agent-demo frontend se ejecuta en un puerto de desarrollo local.
- Decisiones: la semana pasada la sección hero se cambió a un gradiente animado.
- Eventos específicos: se acordó con el equipo A que X se lanza en el Q4.
- Conocimiento específico: esta API se autentica a través de un SDK interno en lugar del endpoint público.

Sus **características clave**:

- **Dinámico**: casi cada sesión sustantiva escribe una o dos entradas.
- **Itemizado**: se agrega entrada por entrada para un fácil recuerdo.
- **Siempre cargado plus coincidencia FTS5 bajo demanda**: las entradas comunes se cargan en cada sesión, las entradas históricas se extraen mediante coincidencias FTS5.
- **Típicamente 8–15 entradas**: un objetivo de 8–15 entradas totales ~2,200 caracteres / ~800 tokens.

Piensa en `MEMORY.md` como **el diario en tu escritorio** — más que una nota adhesiva, pero aún escrito con parsimonia para que siga siendo rápido de escanear.

---

## 3. "¿Por qué no fusionarlos en un único NOTES.md?" — tres restricciones estrictas

Alguien siempre preguntará: ambos son Markdown cargados en cada sesión, así que ¿por qué no fusionarlos?

Aquí están las tres restricciones estrictas, cada una por sí sola lo suficientemente fuerte para hundir la idea.

### Restricción 1: capacidad independiente, sin apriete mutuo

`USER.md` obtiene 500 tokens, `MEMORY.md` obtiene 800. Después de fusionar, un único `NOTES.md` de 1,300 tokens se enfrenta inmediatamente a un problema: **¿cuando la memoria está casi llena, ¿el Agent borra una línea sobre "quién es el usuario" para registrar otro evento más?**

Obviamente **no debería** — pero una vez fusionados, esa decisión tiene que tomarse, y tomarse **en cada escritura**. Manteniéndose separados, los dos pools evolucionan independientemente: cuando `MEMORY.md` se llena solo aprieta a sí mismo y nunca contamina el perfil.

### Restricción 2: diferentes semánticas de carga

Ambos archivos realmente **se cargan en cada sesión**, pero sus roles en el prompt del sistema son completamente diferentes:

- La sección de `USER.md` responde "**quién eres**", estableciendo el tono, nivel de detalle y suposiciones de pila del Agent.
- La sección de `MEMORY.md` responde "**qué hemos hecho juntos**", dando al Agent manijas factuales.

Fusionados, los dos se **diluirían entre sí** — el Agent ya no podría rápidamente determinar "¿esto es un estilo de comunicación que debo seguir, o un hecho pasado que debo citar?"

### Restricción 3: diferentes semánticas de actualización

- **Los campos de preferencia en `USER.md` sobrescrien mayormente**: cuando el usuario dice "deja de resumir desde ahora en adelante", la línea de preferencia relevante se sobrescribe directamente.
- **`MEMORY.md` mayormente agrega y consolida bajo demanda**: los eventos son una serie temporal, por lo que la historia no puede borrarse casualmente. Cuando la capacidad está llena, la siguiente respuesta de error activa la consolidación:

```json
{
  "success": false,
  "error": "Memory at 2,100/2,200 chars. Consolidate now...",
  "current_entries": [...],
  "usage": "2,100/2,200"
}
```

Después de fusionar, `add / replace / remove` tendrían que coexistir en el mismo archivo, haciendo que tanto la implementación como el modelo mental del usuario **peores al mismo tiempo**.

---

## 4. Un ejemplo concreto

Supongamos que le dices al Agent:

> "Soy Jasmin, ingeniera frontend, y me gusta la comunicación de conclusiones primero. Estoy trabajando en el sitio global para agent-demo (una app de Agent de IA) con Next.js. La semana pasada cambiamos la sección hero a un gradiente animado."

Un Hermes Agent bien entrenado lo divide de la siguiente manera:

**Escrito en `USER.md`**:

```md
## Identity
- Name: Jasmin
- Role: Frontend engineer

## Preferences
- Communication style: conclusion first
- Usual stack: Next.js
```

**Escrito en `MEMORY.md`**:

```md
- [2026-07-30] agent-demo: hero section on the global site changed to an animated gradient.
- Related project: agent-demo / global site (global region)
```

¿Ves la diferencia?

- "Qué tipo de persona eres" va al perfil; "qué hemos hecho juntos" va al archivo.
- El primero solo cambia cuando **tú** cambias (nuevo trabajo, nuevo equipo); el segundo crece con **cada día de conversación**.
- **Archivos separados son lo que permite que cada uno evolucione por su cuenta.**

---

## 5. La lista de saltos de cinco elementos

Hermes no empuja todo a `USER.md`. Mantiene una **lista de saltos**:

1. **Mood de una sola vez**: "me duele la cabeza hoy" — no es un atributo estable.
2. **Parámetros de tarea temporal**: "cambia este título a X por mí" — desechable.
3. **Actitudes vagas**: "pienso que prefiero las cosas un poco más concisas" — no lo suficientemente reutilizable (cualifícalo o omítelo).
4. **Cualquier cosa inferible del contexto de conversación en vivo** — no hay necesidad de persistir.
5. **Información sensible** (correos electrónicos, contraseñas, direcciones no confirmadas explícitamente por el usuario) — el contenido relacionado con la privacidad no se escribe por defecto.

Esa lista de saltos es lo que mantiene a `USER.md` en "500 tokens y alta densidad".

---

## 6. Lo que esto significa para los productos

Para un producto de Agent, la división entre `USER.md` y `MEMORY.md` no es solo un detalle de ingeniería. Determina tres cosas:

1. **¿Puedes mostrar a los usuarios "qué pienso de ti"** — eso necesita un perfil estable, legible y editable (la semántica de `USER.md`).
2. **¿Puede el Agent evitar la amnesia a largo plazo** — eso necesita un archivo factual en crecimiento y recuperable (la semántica de `MEMORY.md`).
3. **¿Puede el costo mantenerse acotado** — solo la carga en capas puede tanto "saber quién eres" como evitar quemar un contexto entero.

---

## 7. LightVela: convertir estos dos libros mayores en un producto

El diseño de memoria de Agent interno de LightVela se apoya exactamente en este pensamiento en capas. Los `USER.md` y `MEMORY.md` de Hermes son archivos Markdown escritos para desarrolladores; LightVela los convierte en dos cosas que un usuario ordinario puede operar directamente:

- **Una capa de perfil visible**: los usuarios pueden ver qué hechos de perfil recuerda el Agent y de qué conversación vino cada uno, y corregirlos con un clic. El perfil ya no es un `USER.md` de caja negra.
- **Una capa de hechos organizables**: la memoria factual es más que un montón de entradas — puede etiquetarse por proyecto, tarea o tiempo para un fácil recuerdo y limpieza. En escenarios de equipo, la memoria de equipo y la memoria personal pueden gestionarse como capas separadas.
- **La ruta más corta**: si la idea de memoria en capas te apela pero prefieres no editar `~/.hermes/USER.md`, mantener FTS5 y hacer copias de seguridad de SQLite tú mismo, LightVela es la ruta más corta a esa idea como producto terminado.

En una línea: **Hermes proporcionó el plano de ingeniería para memoria en capas, y LightVela la convierte en una experiencia de producto que cualquiera puede usar.**

---

## Puntos clave

- `USER.md`: un perfil de usuario estable y estructurado cargado en cada sesión (~500 tokens, 8–15 campos de perfil).
- `MEMORY.md`: un archivo factual en crecimiento y bajo demanda (~800 tokens, 8–15 entradas de evento).
- Tres restricciones estrictas los mantienen separados: **capacidad independiente / diferentes semánticas de carga / diferentes semánticas de actualización**.
- La capa es una capacidad fundamental para una buena memoria de Agent, y el punto de partida para productizar la memoria en LightVela.
