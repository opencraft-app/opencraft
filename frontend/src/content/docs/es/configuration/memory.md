# Gestión de la memoria

## Resumen

**La memoria es lo que permite a Hermes retener lo importante a través de las conversaciones y los dispositivos — tus preferencias, quién eres, lo que estás trabajando actualmente y la experiencia que se acumula a través de la colaboración a largo plazo. Es la base que convierte a Hermes de una herramienta de respuestas a preguntas aisladas en un asistente que te entiende mejor con el tiempo. La memoria vive dentro del Agent y fuera del modelo, por lo que cambiar de modelo no hace que olvide. Puedes revisar, editar o limpiar lo que se ha acumulado en la página de memoria y perfil de usuario en el consola, y todos tus canales de mensajería comparten una sola memoria.**

---

La memoria ayuda a Hermes a retener información importante a través de las conversaciones y los dispositivos — tus preferencias, identidad, trabajo en progreso y la experiencia que se desarrolla a través de la colaboración a largo plazo. Es lo que convierte a Hermes de una herramienta de preguntas y respuestas aisladas en un asistente a largo plazo que te entiende mejor con el tiempo.

![La página de Memoria y Perfil de Usuario en la consola de LightVela](../images/memory-management-overview-en.png)

LightVela se aloja en la nube, por lo que estas memorías se almacenan junto con tu instancia de Hermes en la nube. No se pierden cuando cambias de dispositivo o pasas entre Telegram, WhatsApp, Discord, Slack y WeChat. Si le dices algo a Hermes en Telegram hoy, aún podrá recordarlo cuando continúes la conversación en WhatsApp mañana.

## ¿Qué cubre esta página

- El problema que resuelve la memoria

- Dos tipos de memoria: Memoria del Agent y perfil de usuario

- Cómo ver las memorías y el uso de capacidad en el consola

- Cómo ajustar los límites de capacidad de memoria

- Cómo agregar o eliminar memorías a través de la conversación

- Preguntas frecuentes

> 💡 **La memoria se construye automáticamente — no necesitas ingresarla manualmente**
>
> No necesitas rellenar un formulario de memoria. Durante las conversaciones normales, Hermes decide qué información es lo suficientemente útil para retener. La página de Memoria en el consola se utiliza principalmente para **revisar** lo que Hermes recuerda y **ajustar la capacidad** cuando sea necesario.

---

## ¿Por qué importa la memoria

Sin memoria, cada conversación con un asistente de IA comienza en una página en blanco. Tienes que explicar quién eres, qué prefieres y dónde terminó la última conversación. La memoria resuelve ese problema:

- **Repítete menos**: Dile una vez a Hermes que vives en Singapur y prefieres un resumen matutino, y no necesitas repetirlo cada vez.

- **Mantén la consistencia entre canales**: Telegram, WhatsApp, Discord, Slack y WeChat comparten la misma memoria. Cuando cambies de canal, sigues hablando con el mismo asistente que te entiende.

- **Mejora con el uso continuado**: A medida que trabajas juntos, Hermes recuerda tus rutinas, nombres preferidos y proyectos activos, haciendo que sus respuestas sean cada vez más relevantes.

Piensa en la memoria como el cuaderno a largo plazo de Hermes. No preserva cada mensaje casual; retiene los detalles que es probable que sean útiles más tarde.

---

## Dos tipos de memoria

La página de Memoria en el consola tiene dos pestañas, cada una con un propósito diferente:

### Memoria

Esto contiene la **experiencia y los hechos** que Hermes desarrolla a través de la colaboración a largo plazo — preferencias que has compartido, formas acordadas de trabajar y necesidades que se repiten con el tiempo. Hermes mantiene este contenido automáticamente durante las conversaciones, y las entradas evolucionan a medida que continúas usando la herramienta.

### Perfil de usuario

Esto es un registro estable de **quién eres**, como tu identidad, ubicación, antecedentes profesionales y preferencias a largo plazo. En comparación con la memoria general, el perfil de usuario funciona más como una tarjeta de perfil persistente que ayuda a Hermes a entender rápidamente tu contexto básico en cualquier conversación.

> ℹ️ **¿Cómo se diferencian**
>
> En resumen, el **perfil de usuario** responde "¿Qué tipo de persona eres?" mientras que la **memoria** responde "¿Qué ha pasado entre nosotros y qué hemos acordado?". Juntos, ayudan a Hermes a entender tanto a ti como el historial de tu colaboración.

---

## Ver memorías y uso de capacidad

1. Inicia sesión en LightVela y haz clic en "Mi Hermes" en la esquina superior derecha para abrir el consola.

2. Encuentra "Memoria" en la navegación de configuración y abre la página de Memoria.

3. En la parte superior de la página, revisa las **estadísticas de memoria**: caracteres actualmente utilizados, límite de capacidad y porcentaje utilizado.

4. Cambia entre las pestañas "Memoria" y "Perfil de usuario" para revisar cada tipo de contenido.

Si uno de los tipos está vacío, la página mostrará "No hay memoria del Agent" o "No hay perfil de usuario". Esto generalmente significa que no has trabajado con Hermes durante suficiente tiempo para construir ese tipo de memoria. El contenido se acumulará con el tiempo.

> 💡 **¿Qué significa el porcentaje de uso**
>
> La memoria tiene un límite de capacidad. A medida que el uso se acerca a ese límite, Hermes da prioridad a información más importante y elimina entradas obsoletas. Monitorear el porcentaje te ayuda a decidir si aumentar la capacidad o eliminar información que ya no necesitas.

---

## Ajustar límites de capacidad de memoria

Puedes aumentar un límite de capacidad cuando quieras que Hermes retenga más información, o reducirlo cuando sea apropiado.

- **Memoria** se puede establecer desde 500 hasta 4.000 caracteres.

- **Perfil de usuario** se puede establecer desde 500 hasta 3.000 caracteres.

El nuevo límite entra en vigor después de guardarlo.

> ⚠️ **Guardar un nuevo límite reinicia brevemente la puerta de enlace y puede interrumpir la conversación actual**
>
> Cuando guardas un nuevo límite de capacidad, la puerta de enlace de Hermes se reinicia brevemente para aplicar la configuración. Una conversación en progreso puede interrumpirse brevemente y se recuperará poco después. Realiza el cambio en un momento en el que una interrupción breve no afecte tu trabajo.

---

## Agregar o eliminar memoria a través de la conversación

Además de revisar el contenido en el consola, puedes pedir directamente a Hermes que recuerde o olvide información. Esto es generalmente la forma más natural de mantener la memoria durante el uso diario.

**Pídele que recuerde:**

```
Remember that I want my daily briefing at 8:00 AM.
```

```
Remember that I prefer concise, direct answers.
```

**Pídele que olvide:**

```
I no longer need the daily briefing we discussed. Please forget that preference.
```

Hermes interpreta tu intención, actualiza la entrada de memoria relevante y te informa de lo que cambió.

> ℹ️ **El contenido de la memoria se mantiene actualmente a través de la conversación**
>
> LightVela utiliza un modelo en la nube gestionado y no expone operaciones de sistema de archivos para el usuario. Agrega o elimina contenido de memoria principalmente hablando con Hermes; utiliza el consola para revisar el contenido y ajustar los límites de capacidad.

---

## Preguntas frecuentes

### ¿Por qué Hermes recordó algo que no le pedí explícitamente que guardara?

Esto es esperado. Hermes identifica automáticamente información que puede ser útil con el tiempo, como tus preferencias, identidad y acuerdos de trabajo. Si no quieres que guarde algo, pídele que olvide esa información en la conversación.

### ¿La memoria permanece cuando cambio de dispositivo o canal?

Sí. La memoria se almacena junto con la instancia en la nube e es independiente de cualquier dispositivo o canal individual. Telegram, WhatsApp, Discord, Slack y WeChat comparten la misma memoria.

### ¿Qué sucede cuando la memoria alcanza la capacidad?

A medida que el uso se acerca al límite, Hermes prioriza información más importante y elimina gradualmente entradas obsoletas o menos útiles. Si necesitas que retenga más, aumenta el límite de capacidad en la página de Memoria.

### ¿Por qué la página de Memoria dice que no hay memoria?

Ese tipo de memoria aún no ha acumulado ningún contenido. Continúa trabajando con Hermes, o pídele directamente que recuerde un detalle importante, y el contenido comenzará a aparecer.

### ¿Por qué mi conversación se pausó después de cambiar el límite de capacidad?

Guardar un nuevo límite desencadena un reinicio breve de la puerta de enlace, lo que puede interrumpir la conversación brevemente. Espera un poco y luego envía el mensaje nuevamente.

---

## Próximos pasos

La memoria ayuda a Hermes a recordarte. A continuación, dale más formas de actuar:

- [Configurar Skills](./skill.md) — Agrega capacidades como búsqueda de clima, resúmenes y navegación web

- [Tareas programadas](./automation.md) — Permite que Hermes ejecute tareas proactivamente según un horario

- [Resumen de configuración](../05-configuration.md)
