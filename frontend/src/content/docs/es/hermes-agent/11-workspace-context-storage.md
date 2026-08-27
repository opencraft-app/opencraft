## Resumen

**Los archivos de un Hermes Agent no son una carpeta desordenada. Pertenece a tres lugares con responsabilidades distintas. El directorio de trabajo alberga las entradas, salidas y artefactos de ejecución de la herramienta de la tarea actual, y cuenta con una frontera real: las herramientas no pueden vagar más allá del espacio de trabajo hacia rutas de sistema arbitrarias. Los archivos de contexto (`SOUL.md`, `USER.md`, `MEMORY.md`) no son adjuntos ordinarios; son acuerdos a largo plazo que moldean cómo el Agent entiende la relación y el trabajo. El almacenamiento en la nube es el espacio de archivos del Agent para el material de la tarea y la salida: la carga y descarga de archivos individuales soporta hasta 1 GB, la eliminación elimina solo la copia alojada en el almacenamiento en la nube de ese Agent y nunca toca el archivo original en su computadora, y los archivos de un Agent no están automáticamente disponibles para otro Agent. El valor práctico de separar los tres es que siempre sabes dónde reside un documento, quién puede leerlo y cuánto tiempo persiste — lo que mantiene los secretos fuera del contexto a largo plazo y evita que el material importante exista únicamente dentro de un registro de chat.**

---

## Donde residen los archivos determina si el Agent puede continuar donde lo dejó

Imagine un fallo común. Pegas un breve de proyecto en el chat, pides al Agent que extraiga los puntos clave, y hace un buen trabajo. Tres días después vuelves: "basado en ese breve, redacta un calendario". El calendario que produce claramente no coincide — porque el breve solo existió dentro de una conversación de hace tres días, no en ninguna ubicación que pueda recuperarse de manera confiable.

Ahora imagina un segundo fallo. Para ayudar al Agent a "recordar" tu configuración de servidor, escribiste un bloque de configuración que contenía una clave secreta en un archivo de contexto a largo plazo. Desde entonces, ese bloque se lee como fondo en cada sesión. Esto no es el uso previsto de la memoria; es una exposición a largo plazo innecesaria de datos sensibles.

Ambos apuntan al mismo problema: **dónde reside un archivo no es una preferencia de orden. Determina si el material puede recuperarse de manera confiable, quién lo lee y cuánto tiempo persiste.** Este artículo establece los tres lugares y las fronteras de cada uno.

---

## 1. Tres lugares, tres responsabilidades

Comencemos con el panorama general.

| Ubicación | Qué contiene | ¿Quién lo lee? | Ciclo de vida |
|---|---|---|---|
| **Directorio de trabajo** | Entradas de la tarea actual, salidas, artefactos de ejecución de herramientas | Herramientas y ejecución durante esta tarea | Escopado por tarea, de vida más corta |
| **Archivos de contexto** | `SOUL.md`, `USER.md`, `MEMORY.md` | Acuerdos a largo plazo leídos en cada sesión | A largo plazo, mantenido activamente |
| **Almacenamiento en la nube** | Material de la tarea, documentos de referencia, salida digna de conservar | Tú o el Agent, a demanda | A largo plazo; descargable, renombrable, eliminable |

El par más a menudo confundido es **archivos de contexto y almacenamiento en la nube**. Ambos persisten, pero se leen de formas completamente diferentes: los archivos de contexto son fondo residente para cada sesión, mientras que los archivos de almacenamiento en la nube son material que se solicita cuando se necesita y nunca se inyecta automáticamente en cada conversación.

Esa distinción determina directamente cómo debe manejarse la información sensible — cubierto a continuación.

---

## 2. El directorio de trabajo: donde ocurre el trabajo y donde se sitúa la frontera

El directorio de trabajo sirve las entradas, salidas y ejecución de herramientas de la tarea actual. Tiene dos propiedades definitorias.

**Primero, es el sitio de trabajo.** Leer archivos, escribir archivos, ejecutar comandos y producir artefactos ocurren aquí. Un Agent que pueda continuar el trabajo genuinamente necesita el estado intermedio para persistir aquí en lugar de empezar desde cero cada vez.

**Segundo, tiene una frontera clara.** Las herramientas no pueden llegar más allá del espacio de trabajo hacia rutas de sistema arbitrarias. Esa restricción no es una capacidad faltante; es la condición previa que hace que la lectura/escritura de archivos sea utilizable y controlable. Un Agent con lectura/escritura sin restricciones a través de un sistema de archivos completo convierte cualquier juicio erróneo en un resultado potencialmente irreversible.

Entender esta frontera tiene una consecuencia práctica: cuando quieres que el Agent procese un documento, pon el documento en algún lugar donde pueda accederlo en lugar de esperar que busque a través de directorios arbitrarios en tu máquina.

---

## 3. Archivos de contexto: no adjuntos, sino acuerdos a largo plazo

Estos tres archivos a menudo se confunden con "material que subí al Agent". Su rol es enteramente diferente — determinan cómo el Agent entiende esta relación y este trabajo.

| Archivo | Rol principal | Contenido típico |
|---|---|---|
| `SOUL.md` | Rol, tono, límites de comportamiento | Conclusión antes de razonar; sin consejos de inversión |
| `USER.md` | Preferencias y perfil de usuario estables | Prefiere inglés; mantener la terminología tal cual |
| `MEMORY.md` | Hechos entre sesiones, estado del proyecto, decisiones | Nombre del proyecto; decisión de la semana pasada |

Tres formas en que difieren del material subido:

**Diferencia uno: tiempo de lectura.** Los archivos de contexto son fondo residente utilizado en cada sesión; los archivos de almacenamiento en la nube se solicitan solo cuando se necesitan.

**Diferencia dos: forma del contenido.** Los archivos de contexto se adaptan a reglas estables, preferencias y entradas de hechos — no a grandes bloques de material bruto. Empujar un breve de diez páginas en `MEMORY.md` solo sobrecarga cada sesión subsiguiente.

**Diferencia tres: requisitos de sensibilidad.** Dado que son residentes, **no escribas contraseñas, claves o información sensible innecesaria en archivos de contexto a largo plazo.** Cuando el Agent debe manejar configuración sensible, proporciónala a través de una ruta controlada y limpiarla después en lugar de dejarla en el fondo indefinidamente.

Ese tercer punto es la única regla práctica más importante en este artículo.

Para cómo los tres archivos de contexto moldean conjuntamente el comportamiento, ve "De dónde proviene la personalidad del Hermes Agent: Persona, Preferencias y Memoria a Largo Plazo".

---

## 4. Almacenamiento en la nube: el espacio de archivos del Agent

El almacenamiento en la nube se posiciona como el espacio de archivos del Agent: mantén el material de la tarea en un solo lugar, sube y organiza archivos o descarga lo que necesitas localmente — todo desde la consola.

### 4.1 Cuándo usarlo

Usa el almacenamiento en la nube siempre que el Agent necesite material de referencia, documentos de trabajo o un lugar claro para guardar la salida — en lugar de depender de una pega única en el chat. Dos patrones típicos:

- **Subir primero, luego procesar** — sube un breve de proyecto, luego pide al Agent que extraiga los puntos clave. El material permanece disponible para referencia posterior.
- **Crear carpetas para trabajo recurrente** — da a un trabajo en curso una carpeta y manténla, para que la salida tenga un hogar estable.

### 4.2 Límites concretos que vale la pena conocer

Estos son hechos que debes establecer antes de depender de ello:

- **La carga y descarga de archivos individuales soportan hasta 1 GB.** Cualquier cosa más grande necesita dividirse o comprimirse primero.
- **La eliminación elimina solo la copia alojada en el almacenamiento en la nube de ese Agent**, nunca el archivo original en tu computadora. Incluso así, descarga cualquier cosa que puedas necesitar antes de eliminar — la copia alojada se pierde una vez eliminada.
- **Los archivos de un Agent no están automáticamente disponibles para otro Agent.** Mover material entre Agents requiere acción explícita; no asumas un área de archivos compartida.
- **Mantén la página abierta mientras subes**, espera la finalización y confirma que el archivo aparece en la carpeta actual antes de hacer otra cosa.

### 4.3 La estructura de carpetas no necesita ser elaborada

Una recomendación práctica: las jerarquías complejas suelen ser innecesarias. Tres carpetas — material, en progreso, hecho — manejan la mayoría de las situaciones. Añade profundidad solo cuando realmente mejora la rapidez con la que encuentras cosas.

Una prueba de si una estructura es sana: **¿los nombres de las carpetas hacen claro a qué tarea pertenece el material?** Si tienes que abrir una carpeta para recordar qué hay dentro, el nombre ha fallado — y el Agent se basa en esos mismos nombres para juzgar qué material es para.

---

## 5. ¿Dónde debería ir este documento? Un camino de decisión

Ante un documento específico, trabaja a través de estas preguntas en orden.

**Pregunta uno: ¿es una regla, una preferencia o una entrada de hecho?**
Sí → archivos de contexto. Reglas a `SOUL.md`, preferencias a `USER.md`, hechos a `MEMORY.md`. Guarda la conclusión destilada, no el texto de fuente bruto.

**Pregunta dos: ¿es material o salida digna de conservar y probablemente referenciada repetidamente?**
Sí → almacenamiento en la nube. Súbelo en una carpeta adecuada con un nombre que explique su propósito.

**Pregunta tres: ¿sirve solo para esta tarea?**
Sí → maneja en el directorio de trabajo; no se necesita retención a largo plazo.

**Pregunta cuatro: ¿contiene contraseñas, claves o información personal sensible?**
Sí → **manténlo fuera de los archivos de contexto a largo plazo.** Proporciónalo a través de una ruta controlada y límpialo cuando termine la tarea.

El valor de este camino es transformar "déjalo en cualquier lugar" en una elección razonada. La mayoría de la fricción día a día proviene de confundir las preguntas uno y dos — empujar material masivo en archivos de contexto, o dejar material que merece retención dentro de un registro de chat.

---

## 6. Síntomas comunes y dónde buscar

| Síntoma | Causa más probable | Acción sugerida |
|---|---|---|
| El Agent no puede encontrar material que compartiste antes | Solo existe en el historial de chat, nunca persistido | Súbelo al almacenamiento en la nube, luego reférenlo |
| La carga o descarga falla | El archivo excede 1 GB, o dejaste la página en medio de la carga | Revisa el tamaño; recarga y mantén la página abierta |
| Los archivos "desaparecieron" después de moverse a otro Agent | Los archivos pertenecen al almacenamiento del Agent original y no se comparten | Descárgalos del original, luego súbelos al nuevo |
| Preocupado de que eliminar archivos en la nube también elimine los locales | Malentendido del alcance de la eliminación | La eliminación afecta solo la copia alojada, no tu original local |
| Cada sesión se siente pesada y lenta | El material bruto masivo fue empujado en archivos de contexto a largo plazo | Muevelo fuera de los archivos de contexto hacia el almacenamiento en la nube |
| Preocupado por la exposición a largo plazo de secretos | Claves o contraseñas fueron escritas en archivos de contexto | Elimínalas inmediatamente; proporciónalas a través de una ruta controlada en su lugar |

Las dos últimas filas son dos caras del mismo error: **tratar los archivos de contexto como un almacén de documentos**. La prueba es simple — si un contenido no necesita ser leído en cada sesión, no pertenece a un archivo de contexto.

---

## 7. El enfoque de LightVela: hacer las ubicaciones visibles y controlables

Hermes distingue el directorio de trabajo de los archivos de contexto en el nivel de mecanismo, pero la alojamiento y recuperación de material sigue siendo organizado por el operador. La dirección de LightVela es hacer el espacio de archivos visible y controlable como una capacidad del producto:

- **Un espacio de archivos consolidado** — sube, crea, organiza, descarga, renombra y elimina desde la consola sin salir del producto.
- **Fronteras explícitas** — el directorio de trabajo está delimitado, y las herramientas no llegan más allá del espacio de trabajo hacia rutas de sistema arbitrarias.
- **Semántica de eliminación clara** — la eliminación elimina solo la copia alojada en el almacenamiento de ese Agent, deja los originales locales intactos y te pide que descargues primero.
- **Aislamiento entre Agents** — áreas de archivos separadas por Agent, para que el material no se filtre donde no debería compartirse.
- **Desacoplado de otras capacidades** — cambiar modelos no reescribe archivos en el almacenamiento en la nube.

---

## Puntos clave

- Tres lugares, tres roles: **directorio de trabajo** (sitio de trabajo delimitado), **archivos de contexto** (acuerdos a largo plazo residentes), **almacenamiento en la nube** (material y salida solicitados a demanda).
- Los archivos de contexto y el almacenamiento en la nube difieren en el tiempo de lectura: el primero es residente en cada sesión, el segundo es a demanda.
- Hechos de almacenamiento en la nube: **1 GB** de límite de carga/descarga por archivo; la eliminación elimina solo la copia alojada; **los archivos de un Agent no están automáticamente disponibles para otro**.
- Las estructuras de carpetas se mantengan simples — material / en progreso / hecho suele ser suficiente, con nombres que expliquen el propósito.
- Una regla para retener: **nunca escribas contraseñas, claves o información sensible innecesaria en archivos de contexto a largo plazo.**
- Cuando las sesiones se sienten pesadas o lentas, revisa primero si el material masivo fue empujado en archivos de contexto.
