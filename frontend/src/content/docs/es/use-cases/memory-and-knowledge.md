# Cómo gestionar la memoria a largo plazo y el conocimiento personal con un Agent

## Resumen

**El conocimiento personal se presenta en dos formas que deben gestionarse por separado: la información estable sobre quién eres y cómo trabajas pertenece a la memoria a largo plazo, mientras que los documentos en evolución, apuntes y material de proyectos pertenecen al almacenamiento en la nube.** Gestionar ambos como una sola cosa te cuesta estabilidad y encontrabilidad al mismo tiempo. En LightVela, la memoria preserva el contexto entre conversaciones — la página de memoria de la consola muestra lo que se ha retenido a través de las pestañas de Memoria y Perfil de Usuario y te permite ajustar el límite de capacidad, mientras que las adiciones y eliminaciones ocurren principalmente a través de la conversación con Hermes. El almacenamiento en la nube es el espacio de trabajo de archivos, que soporta carga, creación, organización, descarga, renombrado y eliminación, con un límite de 1 GB por archivo. Una regla que debes guardar: nunca escribas contraseñas, claves o datos sensibles innecesarios en la memoria a largo plazo.

![Memoria del Agent LightVela y conocimiento personal](../images/use-case-agent-memory.webp)

## Para quién es esto

Este patrón es para personas que desean un asistente que entienda sus preferencias y trabajos recurrentes sin pedirle que memorice cada documento. Es útil para proyectos continuos, investigación personal, apuntes de aprendizaje, trabajo con clientes y cualquier flujo de trabajo donde el mismo contexto regresa con el tiempo.

El objetivo no es crear un archivo perfecto. Es hacer que el contexto importante sea fácil de encontrar y mantener a Hermes alineado con las partes de él que deben persistir.

## Requisitos previos

- Un Agent Hermes en ejecución y una forma de chatear con él a través de la consola o un canal conectado.

- Una comprensión básica de los dos lugares donde puede vivir la información: [Gestión de Memoria](../configuration/memory.md) para el contexto a largo plazo, y [Almacenamiento en la Nube](../configuration/files.md) para archivos y carpetas.

- Un pequeño conjunto de materiales a los que realmente vuelves, en lugar de una lista desfiltrada de cada archivo que poseas.

- Un límite claro de privacidad sobre lo que deseas que Hermes retenga o revise.

## Pasos / conceptos clave

### 1. Separa el contexto estable del material de referencia

Coloca los hechos que deben dar forma a futuras conversaciones en la memoria: tu estilo de escritura preferido, zona horaria, rol en curso, metas recurrentes o reglas sobre cómo deseas que se maneje un proyecto. Mantén los materiales cambiantes —briefings, apuntes de reuniones, borradores y archivos de investigación— en el Almacenamiento en la Nube.

Por ejemplo, podrías decirle a Hermes:

```text
Remember that I prefer research notes to separate facts, assumptions,
and open questions. Use that structure whenever we review a project.
```

El punto no es hacer que Hermes guarde cada documento de fuente como memoria. El punto es darle una forma duradera de entender cómo deseas que se manejen esos documentos.

### 2. Organiza los archivos que esperas revisar

Crea una pequeña estructura de carpetas en el Almacenamiento en la Nube que coincida con tu trabajo real. Usa nombres significativos y mantén el material relacionado junto, como una carpeta por cliente, proyecto, curso o pregunta de investigación.

Cuando necesites ayuda con un archivo, dile a Hermes qué estás intentando hacer e identifica el material relevante. Por ejemplo:

```text
Help me prepare for this project review. Use the latest brief and my
meeting notes, then list unresolved decisions and questions.
```

![Una carpeta de Almacenamiento en la Nube con archivos de proyecto](../images/use-case-memory-knowledge-storage.png)

### 3. Revisa la memoria en lugar de asumir que es correcta para siempre

Abre Gestión de Memoria periódicamente para revisar las pestañas de Memoria y Perfil de Usuario. El perfil de usuario es la imagen estable de quién eres; la memoria contiene la experiencia útil y el contexto de trabajo de tu colaboración con Hermes.

Si una preferencia cambia, dilo claramente en la conversación:

```text
I no longer want long weekly updates. Please forget that preference
and keep weekly summaries to five bullets.
```

La memoria funciona mejor cuando se mantiene actualizada. Elimina o corrige el contexto que llevaría a Hermes en la dirección equivocada en lugar de agregar una segunda instrucción contradictoria.

### 4. Convierte el conocimiento revisado en una conversación funcional

Usa la página [Chat](../configuration/agent-chat.md) o un canal conectado para convertir documentos y memoria en una siguiente acción concreta. Pide una comparación, un esquema, un conjunto de preguntas abiertas o un resumen para una reunión específica. Cuanto más específico sea el resultado inmediato, más fácil será verificar que Hermes tenga el contexto correcto.

Si tu revisión sigue un ritmo recurrente, una [Tarea programada](../configuration/automation.md) puede recordarte para revisar una carpeta o preparar un resumen regular. Comienza con un recordatorio o resumen simple en lugar de conceder una tarea amplia y sin límites.

![Una conversación del Agent Hermes usando conocimiento de proyecto organizado](../images/use-case-memory-knowledge-automation.png)

## Preguntas frecuentes

### ¿Cuál es la diferencia entre memoria y Almacenamiento en la Nube?

La memoria es el contexto duradero que ayuda a Hermes a entenderte y tu colaboración en curso. El Almacenamiento en la Nube es para los archivos y carpetas que gestionas. La memoria debe capturar las reglas e importantes preferencias; los archivos deben contener el material subyacente.

### ¿Trata Hermes automáticamente cada archivo como memoria a largo plazo?

No. Mantén la distinción deliberada. Usa Gestión de Memoria para el contexto persistente, y usa Almacenamiento en la Nube para organizar materiales que deseas referenciar durante trabajos específicos.

### ¿Puedo pedirle a Hermes que olvide algo?

Sí. Dile a Hermes qué ya no debe retenerse, luego revisa la información de memoria o de perfil de usuario relevante si deseas confirmar el cambio.

### ¿Qué debería poner en la memoria primero?

Comienza con preferencias que cambian la calidad de casi cada conversación: tu zona horaria, estilo de comunicación, rol, prioridades activas y el formato que prefieres para el trabajo recurrente.

## Próximos pasos

- [Gestión de Memoria](../configuration/memory.md) — revisa el contexto a largo plazo y la capacidad.

- [Almacenamiento en la Nube](../configuration/files.md) — mantén los documentos detrás de tu trabajo en curso organizados.

- [Chat](../configuration/agent-chat.md) — pon a la memoria y el material del proyecto a trabajar en una conversación enfocada.
