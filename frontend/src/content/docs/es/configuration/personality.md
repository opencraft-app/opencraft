# Almas

## Resumen

**La personalidad define el rol estable, la voz, las prioridades y los límites de comportamiento para un Hermes Agent.**

**Elige un Alma desde la configuración de Personalidad del Agent, revisa su descripción e inyecta la para actualizar el `SOUL.md` del Agent.**

**Solo una Alma está activa para un Agent a la vez, y debes iniciar una nueva conversación después de cambiarla para que se carguen las reglas actualizadas.**

![Tarjetas de personalidad de Alma en la consola de LightVela](../images/soul-1.png)

## ¿Qué cubre esta página

- Qué controlan la Personalidad y las Almas
- Cómo elegir e inyectar una Alma
- Cómo verificar que la nueva personalidad está activa
- Cómo mantener la personalidad, preferencias del usuario, memoria y Skills separadas
- Límites comunes y pasos de solución de problemas

## Qué controla la Personalidad

Una Alma es la personalidad seleccionada que LightVela escribe en el `SOUL.md` del Agent.
Define quién es el Agent, cómo se comunica normalmente, qué prioriza y qué límites debe respetar.

Usa la Personalidad para instrucciones estables como "llevar la conclusión primero", "establecer la incertidumbre claramente" o "preguntar antes de tomar una acción externa".
No la uses como un lugar para cambiar hechos del proyecto, solicitudes puntuales o como un editor de archivos en la nube de propósito general.

La Personalidad pertenece al Agent, no a un único canal de conversación.
Si el mismo Agent está conectado a Telegram y WhatsApp, sus nuevas conversaciones en ambos canales usan la misma Alma activa.

## Antes de empezar

1. Abre el Hermes Agent cuya personalidad quieres configurar.
2. Asegúrate de que el Agent tenga un modelo y al menos un canal de conversación utilizable para poder verificar el resultado.
3. Decide el rol, el público, la voz, las prioridades y las acciones que siempre deben requerir confirmación.

Un breve resumen suele ser suficiente.
Por ejemplo: "Un asistente de investigación conciso que da la conclusión antes de la evidencia, nombra la incertidumbre y pregunta antes de enviar algo fuera de la conversación."

## Configurar una Alma

### Abrir Personalidad

1. Abre **Agents** en la consola de LightVela.
2. Selecciona el Hermes Agent que quieres configurar.
3. Abre la sección **Personality** en la configuración de ese Agent.

La configuración solo aplica al Agent seleccionado.
Cambia a otro Agent antes de configurarlo si quieres un rol o voz diferente en otro lugar.

### Elegir una Alma

Usa **Draw random soul** para explorar los estilos de personalidad disponibles.
Usa **Soul personality test** cuando quieras una recomendación basada en tus preferencias de comunicación y comportamiento.

![Diálogo de Draw random soul](../images/soul-2.png)

Revisa el rol, la voz, la descripción del comportamiento y los límites en cada tarjeta de Alma antes de tomar una decisión.
Elige una Alma que coincida con el breve que preparaste en lugar de seleccionarla solo por su nombre o tono.

### Inyectar la Alma

1. Selecciona la Alma que quieres usar.
2. Selecciona **Inject soul**.
3. Confirma el resultado de la inyección en la sección de Personalidad.
4. Vuelve a un canal de conversación conectado y envía `/new`.

Cuando la inyección tiene éxito, LightVela escribe la Alma seleccionada en el `SOUL.md` del Agent actual y mantiene una copia de seguridad antes de reemplazar una personalidad existente.
Una conversación existente puede seguir reteniendo la captura de personalidad anterior, por lo que `/new` inicia una conversación que lee la Alma actualizada.

### Cargar tu propia Alma

Usa esta opción cuando ya tienes una Alma en Markdown que quieres aplicar en lugar de elegir una tarjeta recomendada.

1. Selecciona el Hermes Agent objetivo en la consola de LightVela.
2. En **Personality**, selecciona **Upload personality file**.
3. Elige el archivo Markdown que contiene tu Alma.
4. Revisa o edita su contenido, luego selecciona **Inject**.
5. Si el Agent ya tiene una Alma, confirma que quieres reemplazarla.
6. Vuelve a un canal de conversación conectado y envía `/new`.

![Diálogo de carga de archivo de personalidad](../images/soul-3.png)

El nombre del archivo no necesita ser `soul.md`, pero debe usar la extensión `.md`, estar codificado en UTF-8 y no superar los 20 KB.
LightVela muestra el contenido del archivo antes de la inyección para que puedas hacer ediciones finales.
Cuando reemplazas una Alma existente, LightVela la respalda antes de escribir el contenido cargado en el `SOUL.md` del Agent seleccionado.

La carga está disponible solo cuando se ha seleccionado un Agent.
Si necesitas una copia descargable de una Alma recomendada porque no se ha seleccionado un Agent o el contenedor del Agent no puede escribir la nueva configuración, usa el archivo `soul.md` solo como una solución local de respaldo.
Descargar ese respaldo no actualiza un Agent por sí solo.

## Mantener cada tipo de contexto en el lugar correcto

| Almacenarlo en | Usarlo para | Ejemplo |
| --- | --- | --- |
| Personalidad y `SOUL.md` | Rol estable, voz, prioridades y límites de comportamiento | "Establece la incertidumbre explícitamente y pregunta antes de enviar mensajes externos." |
| Perfil de usuario | La identidad del usuario, ubicación, idioma y preferencias de comunicación | "Usa inglés por defecto y muestra las fechas límite primero." |
| Memoria | Cambios de hechos, decisiones y contexto de proyecto a largo plazo | "El lanzamiento actual del proyecto es el viernes." |
| Skills | Capacidades y procedimientos reutilizables | Búsqueda web, organización de archivos o flujos de trabajo de informes diarios |

Usa [Gestión de Memoria](./memory.md) para revisar la capacidad de memoria y perfil de usuario.
Usa [Configurar Skills](./skill.md) cuando el Agent necesita una nueva capacidad en lugar de una nueva regla de personalidad.
Para una explicación más profunda de estos límites, consulta [De dónde proviene la personalidad del Hermes Agent](../hermes-agent/10-persona-user-memory.md).

## Verificar que la Alma está activa

Después de enviar `/new`, prueba al Agent con varias solicitudes que revelen su comportamiento configurado.

```text
What is your current role, main job, and default voice?
```

```text
How do you respond when you are uncertain about a fact?
```

```text
If I ask you to send a message to an external service, what do you do first?
```

La nueva Alma está activa cuando el Agent sigue consistentemente el rol, la voz y los límites intencionados en una nueva conversación.
Si necesitas una guía paso a paso específica para un canal, consulta [Cómo definir el rol, la personalidad y la voz de un Agent de IM con SOUL.md](../use-cases/im-agent-persona-soul-md.md).

## Solución de problemas de problemas comunes

| Problema | Causa probable | Qué hacer |
| --- | --- | --- |
| Las respuestas siguen usando el tono anterior | La conversación comenzó antes de que cambiara la Alma | Envía `/new`, luego prueba el comportamiento nuevamente en la nueva conversación. |
| La Alma seleccionada no se ajusta al trabajo real del Agent | La tarjeta de Alma fue elegida por estilo en lugar de rol y límites | Vuelve a Personalidad, revisa los detalles de la tarjeta e inyecta una Alma que coincida con el breve del Agent. |
| El Agent olvida un hecho del proyecto | Un hecho cambiante se colocó en la Personalidad en lugar de en la Memoria | Mantén reglas estables en `SOUL.md` y pide a Hermes que recuerde el hecho cambiante. |
| El Agent no puede realizar una tarea necesaria | La Personalidad define el comportamiento, no las capacidades | Instala o configura una Skill adecuada después de revisar su fuente y permisos. |
| La consola descarga `soul.md` en lugar de aplicarlo | No se seleccionó un Agent, o el contenedor del Agent no pudo escribir la nueva configuración | Selecciona el Agent objetivo en ejecución e intenta la inyección nuevamente. Un archivo descargado no cambia al Agent. Envía `/new` solo después de que la consola confirme que la inyección tuvo éxito. |
| No puedo cargar mi propia Alma | No se seleccionó un Agent, o el archivo no es un archivo Markdown UTF-8 válido dentro de 20 KB | Selecciona el Agent objetivo, luego carga un archivo `.md` que cumpla con los requisitos del archivo. |

## Preguntas frecuentes

### ¿Puede un Agent tener varias Almas activas?

No.
Un Agent tiene una Alma activa a la vez.
Crea Agents separados cuando necesites roles verdaderamente diferentes en lugar de reemplazar repetidamente la personalidad de un Agent.

### ¿Puedo editar el `SOUL.md` en la nube manualmente?

El uso normal no requiere operaciones directas del sistema de archivos en la nube.
La configuración de Personalidad genera e inyecta la Alma, pero no es un editor de propósito general para archivos en la nube arbitrarios.

### ¿Puedo cargar un `SOUL.md` existente?

Sí.
Usa **Upload personality file** para elegir un archivo Markdown UTF-8 de hasta 20 KB, revisa o edita y lo inyecta en el Agent seleccionado.
Si el Agent ya tiene una Alma, LightVela pide confirmación y mantiene una copia de seguridad antes de reemplazarla.

### ¿Cambia una Alma nueva capacidades instaladas?

No.
Una Alma cambia cómo se comporta el Agent, mientras que las Skills agregan capacidades concretas y procedimientos reutilizables.

### ¿Una nueva Alma borra la memoria o el historial de chat?

No.
Inyectar una Alma reemplaza la configuración de personalidad actual del Agent.
No elimina la memoria a largo plazo ni el historial de conversación existente.
