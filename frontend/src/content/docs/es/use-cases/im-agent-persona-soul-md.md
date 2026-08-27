# Cómo definir el rol, la personalidad y la voz de un Agent IM con SOUL.md

## Resumen

**¿Siente un Agent IM como "la misma persona"?** Depende de su personalidad, no de por qué canal se ejecute. `SOUL.md` lleva el rol, el tono, las prioridades, el comportamiento y los límites, y es el archivo de personalidad central en el runtime Hermes. En LightVela nunca tocas el sistema de archivos de la nube directamente; la sección de Personalidad en la página de configuración de un Agent ofrece dos puntos de entrada: dibujar una personalidad al azar o responder a un cuestionario breve. Revisa el rol, el tono y las notas de comportamiento de una tarjeta de personalidad, luego elige Inyectar Personalidad para aplicarla. Escribe principios juzgables en lugar de hechos específicos: "lidera con la conclusión", "establece la incertidumbre explícitamente" y "confirma antes de enviar mensajes externos" son reglas de personalidad, mientras que los nombres de proyectos y puertos pertenecen a la memoria a largo plazo. Después de la inyección, verifica el tono y los límites con una conversación real.

![Definición del rol, la personalidad y la voz de un Agent IM con SOUL.md](../images/use-case-05-im-agent-persona-soul-md.png)

## Para quién es este documento

Esta guía es para personas que quieren dar a un Agent IM un rol estable, como un asistente personal, socio de investigación, compañero de estudios o asistente de comunicación con clientes diarias.
Si aún no has elegido un canal de mensajería, comienza con [Cómo conectar un Agent IA a plataformas de mensajería](./chinese-messaging-channels.md).

## Comprende primero las tres capas de contexto

### `SOUL.md`: quién es el Agent y cómo funciona

`SOUL.md` es lo mejor para reglas de personalidad estables, incluyendo rol, voz, prioridades, comportamiento y límites.
Reglas como "dar la conclusión primero", "establecer la incertidumbre claramente" y "preguntar antes de enviar un mensaje externo" pertenecen aquí.

### Perfil de usuario: quién eres y cómo quieres ser tratado

El perfil de usuario es lo mejor para tu idioma, zona horaria, identidad, antecedentes y preferencias de comunicación.
Por ejemplo, "estoy en Singapur", "usar inglés por defecto" y "mostrar plazos primero" son usualmente preferencias de usuario, no reglas de identidad de Agent.

### Memoria a largo plazo: lo que has establecido juntos

La memoria a largo plazo es lo mejor para el estado del proyecto, decisiones y contexto reutilizable de tu trabajo compartido.
Crecen a través de conversaciones continuas y pueden revisarse o gestionarse en [Gestión de Memoria](../configuration/memory.md).

Mezclar las tres hace que la identidad del Agent, las preferencias de usuario y el contexto del proyecto temporal interfieran entre sí.
Mantenerlas separadas permite que la personalidad se mantenga estable mientras la conversación se adapta al usuario real y al trabajo.

## Requisitos previos

- Un Agent Hermes LightVela en ejecución.
  Si aún no has creado uno, comienza con el [Quickstart](../02-quickstart.md).

- Un modelo configurado y al menos un canal de conversación disponible.

- Un breve de personalidad corto.
  Decide quién sirve el Agent, qué hace principalmente, cómo debe sonar y qué acciones siempre requieren confirmación.

## Pasos / conceptos clave

### 1. Define el objetivo de la personalidad con cinco preguntas

Antes de elegir una Alma, responde estas cinco preguntas:

- ¿Quién es el Agent?

- ¿A quién ayuda principalmente?

- ¿Cómo debería sonar normalmente?

- ¿Qué debe hacer cuando la información es incierta?

- ¿Qué acciones externas requieren confirmación primero?

Convierte las respuestas en un breve de planificación como este:

```text
Role: A research assistant for personal projects
Audience: A user who wants reliable conclusions quickly
Voice: Concise, professional, friendly, conclusion first, evidence second
Behavior: Break down questions, flag uncertainty, and ask only one key question when needed
Boundaries: Never send external messages, change files, or take high-risk actions without confirmation
```

Esta plantilla te ayuda a elegir y calibrar una personalidad.
No significa que LightVela exponga un editor de propósito general para archivos de nube arbitrarios.

### 2. Abre Personalidad en la configuración del Agent

En la consola LightVela, abre la configuración del Agent Hermes objetivo y selecciona "Personalidad".
El sitio internacional ofrece tanto "Dibujar alma al azar" como "Prueba de personalidad de Alma" como puntos de entrada.

Usa el sorteo aleatorio para explorar diferentes estilos de rol.
Usa la prueba de personalidad cuando quieras una Alma que mejor se ajuste a tus preferencias de comunicación y comportamiento.

Revisa la descripción de rol, voz y comportamiento en cada tarjeta, luego elige la que mejor se ajuste a tu breve de planificación.

### 3. Inyecta la Alma seleccionada en `SOUL.md`

Selecciona la Alma y haz clic en "Inyectar alma".
LightVela escribe la Alma seleccionada en el `SOUL.md` del Agent Hermes actual y mantiene una copia de seguridad antes de reemplazar un archivo existente.

Solo una personalidad está activa para un Agent a la vez.
Si quieres cambiar de roles, revisa los límites de la nueva tarjeta antes de inyectarla nuevamente.

Después de que la inyección tenga éxito, vuelve a tu canal IM y envía:

```text
/new
```

El Agent Hermes lee el nuevo `SOUL.md` cuando comienza una nueva conversación.
Esto importa porque una conversación existente puede aún mantener la captura de la personalidad anterior.

### 4. Agrega preferencias de usuario y hechos duraderos a través de la conversación

No pongas cada pieza de información en `SOUL.md`.
Mantén la personalidad estable corta, y deja que el perfil de usuario y la memoria a largo plazo manejen preferencias personales y hechos de proyecto.

Por ejemplo, di a Hermes:

```text
Remember that I am in Singapore time and want a concise weekday plan at 8:00 AM, with deadlines listed first.
```

O:

```text
Forget the Friday evening reminder preference I mentioned earlier. Do not schedule it again.
```

Hermes maneja solicitudes de recordar y olvidar a través de la conversación.
Usa [Gestión de Memoria](../configuration/memory.md) para revisar el contenido de Memoria y Perfil de Usuario y la capacidad.

### 5. Instala Skills solo para trabajo real

La personalidad define cómo funciona el Agent, pero no agrega automáticamente capacidades externas.
Si quieres que navegue, organice materiales, busque información o realice otra tarea concreta, instala una Skill adecuada y revisa su fuente y permisos primero.

Comienza con [Configurar Skills](../configuration/skill.md).
Las Skills y la personalidad deben reforzarse entre sí, no usar una Skill de alto riesgo para compensar límites de personalidad poco claros.

## Verifica que la personalidad esté activa

Después de iniciar una nueva conversación, haz más que pedir una autointroducción.
Prueba al menos estos cuatro casos:

```text
What is your current role, main job, and default voice?
```

```text
How do you respond when you are uncertain about a fact?
```

```text
If I ask you to send a message to an external service, what do you do first?
```

```text
Turn this material into conclusions, evidence, and questions that still need confirmation.
```

Verifica si el Agent preserva el rol, la voz y los límites de seguridad, y si puede seguir usando el contexto relevante del perfil de usuario y la memoria a largo plazo.
Si el comportamiento es inestable, simplifica las reglas de personalidad antes de elegir o inyectar otra Alma.

## Preguntas frecuentes

### ¿Necesito editar el `SOUL.md` de la nube manualmente?

Normalmente no.
La entrada de Personalidad de LightVela genera e inyecta la Alma, por lo que el uso normal no requiere operaciones directas de sistema de archivos de la nube.

### ¿Cambia `SOUL.md` afecta a cada canal de mensajería?

Afecta el comportamiento del nivel de Agent para el mismo Agent Hermes.
Si ese Agent está conectado a Telegram y WhatsApp, ambos canales usan la personalidad en nuevas conversaciones, mientras que cada canal aún tiene su propia autorización, formato de mensaje y límites de capacidad.

### ¿Puede `SOUL.md` reemplazar la memoria?

No.
`SOUL.md` debe describir la identidad estable y reglas de comportamiento, mientras que la memoria debe retener hechos cambiantes, contexto de proyecto y experiencia compartida.

### ¿Puede un Agent tener varias personalidades activas al mismo tiempo?

Actualmente, un Agent tiene una personalidad activa a la vez.
Si necesitas roles completamente diferentes, crea Agents separados en lugar de sobrescribir repetidamente la Alma en un Agent.

### ¿Cuándo debo enviar `/new`?

Envía `/new` en el canal IM después de inyectar una nueva personalidad.
Esto hace explícito que la nueva Alma debe cargarse durante la inicialización de la conversación.

## Próximos pasos

- [Cómo configurar un Agent Hermes con una personalidad distinta en Telegram](./telegram-persona-agent.md) - Aplica la personalidad a conversaciones 1 a 1 en Telegram.

- [Cómo configurar un Agent Hermes con una personalidad distinta en WhatsApp](./whatsapp-persona-agent.md) - Aplica la personalidad a conversaciones 1 a 1 en WhatsApp.

- [De dónde proviene la personalidad del Agent Hermes](../hermes-agent/10-persona-user-memory.md) - Entiende la Personalidad, preferencias de usuario y memoria a largo plazo en mayor profundidad.

- [Almacenamiento en la Nube](../configuration/files.md) - Gestiona material de referencia y archivos de trabajo que el Agent puede usar.
