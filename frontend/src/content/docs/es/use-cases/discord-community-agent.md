# Conozca LightVela para Discord: Su Asistente de IA de Discord que Siente su Canal

## Resumen

**LightVela le permite conectar un Hermes Agent alojado en la nube a Discord, darle contexto de comunidad aprobado y límites de operación, y hacerlo disponible para preguntas recurrentes, incorporación y soporte de eventos.** La ruta mínima consiste en crear un Agent, configurar sus instrucciones, conectar el canal de Discord, invitar el bot y probar una pregunta real en la conversación de Discord compatible.

Los productos compartidos de Agent recientes como [Claude Tag](https://www.anthropic.com/news/introducing-claude-tag) y [Viktor](https://slack.com/marketplace/A0A2VN5TR5K-viktor) muestran por qué un Agent puede ser más útil cuando funciona donde ya se comunica un grupo.
LightVela trae ese patrón a las comunidades de Discord sin requerir que construya e hospite una aplicación de bot separada primero.

![LightVela Agent conectado a una comunidad de Discord](../images/use-case-discord-community-agent.webp)

## Para quién es esto y resultado esperado

Este caso de uso es para comunidades de gaming, comunidades de desarrolladores, grupos de interés y servidores de eventos que desean un asistente de IA confiable en el espacio de conversación que ya utilizan.

El resultado esperado es un Agent de Discord bien instruido que pueda responder preguntas aprobadas, indicar a los miembros el canal correcto o información de eventos, apoyar la incorporación y enviar recordatorios configurados cuando una Tarea programada es apropiada.

No es un reemplazo para moderadores humanos.
Las decisiones de moderación sensibles, acciones de cuenta, disputas y cualquier cosa fuera del límite de conocimiento aprobado deben ir a un humano.

## Requisitos previos

- Un Hermes Agent LightVela en ejecución con un modelo configurado.

- Una cuenta de Discord y un servidor donde tenga permiso para agregar un bot.

- Material de fuente aprobado como reglas del servidor, preguntas frecuentes, detalles de eventos, propósitos de canal y contactos de escalación.

- Un límite claro de lo que el Agent puede responder, lo que debe rechazar y cuándo debe escalar.

- La [guía de configuración de canal de Discord](../configuration/channel-discord.md) y la [guía de Tarea programada](../configuration/automation.md) disponibles para referencia.

## Pasos

### 1. Cree el Agent antes de invitar el bot

Comience con el rol y el resultado del Agent en lugar de con credenciales de Discord.
El bot de Discord es un punto de entrada a Hermes, por lo que las instrucciones y el modelo configurados en LightVela determinan cómo se comporta después de que se conecta.

Escriba las preguntas más comunes de la comunidad y la respuesta más pequeña útil para cada una.
Por ejemplo, liste la página de reglas, canal de soporte, horario de eventos, proceso de registro y ruta de escalación de moderadores.

### 2. Dé al Agent contexto de comunidad aprobado

Configure el Agent con la información que está permitido usar y los límites que debe seguir.
Una instrucción útil de inicio podría verse así:

```text
You are the community assistant for this Discord server.

Answer questions using approved information.
Help members find the right channel or event details.
Be friendly and concise.
Escalate sensitive moderation issues to human moderators.
Never invent rules, announcements, or event times.
If the approved information does not answer a question, say that you do not know and point the member to a human moderator.
```

Mantenga preferencias de operación duraderas en el contexto configurado del Agent.
Mantenga cambios de horarios, anuncios y materiales de eventos en el flujo de trabajo donde puedan ser revisados antes de que el Agent los utilice.
No coloque tokens de bot, contraseñas o información personal innecesaria en el contexto a largo plazo.

### 3. Conecte Discord e invite el bot

En LightVela, abra la configuración de canal y seleccione Discord.
Cree o seleccione la Aplicación de Discord, agregue un Bot, genere su token y pegue el token en la tarjeta de conexión de Discord.

En el Portal de Desarrolladores de Discord, habilite el Intento de Contenido de Mensaje requerido para leer el contenido del mensaje.
Use el conjunto más pequeño de alcances y permisos de bot que su servidor necesite, como ver canales, enviar mensajes y leer historial de mensajes.
Luego genere el enlace de invitación y agregue el bot al servidor destinado.

Siga los pasos completos de [configuración de Discord](../configuration/channel-discord.md) para el flujo actual de autorización y permisos.

![Permisos de bot de Discord en el Portal de Desarrolladores](../images/discord-6-global.webp)

### 4. Pruebe el Agent con preguntas reales de la comunidad

Después de que la consola muestre Discord como conectado, envíe varias preguntas representativas de la conversación de Discord compatible.
Use preguntas que prueben tanto respuestas útiles como incertidumbre segura:

```text
Where can I find the event schedule?

Which channel should I use for technical support?

I am new here. What should I read first?

What is the rule for an issue that is not covered in the FAQ?
```

El resultado esperado no es solo una respuesta fluida.
El Agent debe usar la información aprobada, mantener la respuesta concisa, evitar inventar una regla y escalar cuando la pregunta necesita a un moderador.

Si el bot no responde, primero confirme que el canal de Discord se muestra como conectado, el modelo está disponible, el bot tiene permiso para leer y enviar mensajes y el Intento de Contenido de Mensaje está habilitado.

### 5. Agregue soporte recurrente solo después de que la ruta principal funcione

Una vez que la respuesta de preguntas sea confiable, agregue una Tarea programada estrecha para trabajo recurrente como un recordatorio de registro, un contador de eventos o un resumen de moderador.
Las Tareas programadas de LightVela soportan una ejecución única, días fijos de la semana o intervalos fijos, con una ventana de efectividad opcional y canales de notificación.

Por ejemplo, podría configurar:

```text
Every Thursday at 18:00, remind the event channel about Saturday's tournament.
Use only the approved schedule and rules.
Include the start time, time zone, registration deadline, and the channel for questions.
If any detail is missing, say which detail needs a moderator update instead of guessing.
```

Comience con un solo recordatorio y revise su salida antes de agregar más trabajo programado.
Vea [Tareas programadas](../configuration/automation.md) para los ajustes de horario y notificación disponibles.

## Lista de verificación práctica

| Etapa | Acción | Componente de LightVela | Resultado esperado o señal de fallo |
| --- | --- | --- | --- |
| Definir | Escriba el rol de la comunidad, hechos aprobados y reglas de escalación | Instrucciones del Agent | Un moderador puede explicar qué puede y qué no puede responder el Agent |
| Conectar | Agregue el token de Bot de Discord e invite el bot con permisos de mínimo privilegio | Canal de Discord | Discord aparece como conectado y el bot está presente en el servidor |
| Probar | Haga una pregunta de FAQ conocida y una pregunta desconocida o sensible | Conversación de Discord | El primero obtiene una respuesta fundamentada y el segundo se rechaza o se escala |
| Repetir | Agregue un recordatorio o resumen con un horario estrecho | Tarea programada | El mensaje llega en el canal de notificación seleccionado en la hora esperada |
| Revisar | Verifique respuestas, horarios e información de eventos cambiada | Gestión de Agent y Tarea programada | Reglas y anuncios obsoletos se corrigen antes de que causen confusión |

## Qué puede ayudar un Agent de Discord compartido

### Responda las preguntas que todos hacen

Cada comunidad repite un pequeño conjunto de preguntas:

- ¿Dónde está el horario de eventos?

- ¿Qué canal es para soporte?

- ¿Cómo me uno al torneo?

- ¿Dónde están las reglas del servidor?

Los miembros pueden preguntar al Agent en la conversación de Discord compatible en lugar de esperar a que un moderador esté en línea.
La respuesta se mantiene consistente cuando la información aprobada es clara, y el Agent puede decir que no lo sabe cuando la información falta.

### Ayude a ejecutar eventos sin convertirse en el gerente de eventos

Los eventos crean muchas pequeñas preguntas sobre registro, zonas horarias, recordatorios de reglas y cambios de última hora.
El Agent puede manejar las preguntas repetitivas y entregar un recordatorio configurado mientras los organizadores mantienen el control de la información de fuente y decisiones finales.

### De a nuevos miembros una mejor primera hora

Un nuevo miembro puede comenzar con una pregunta simple como:

```text
I am new here. Where should I start?
```

El Agent puede indicarles los canales correctos, explicar los básicos de la comunidad aprobados y ofrecer un siguiente paso.
Eso hace que la primera interacción sea útil sin pedir al Agent que tome decisiones de moderación.

## Comparado con programar un bot de Discord desde cero

Un bot de Discord personalizado es la opción correcta cuando necesita comandos profundamente a medida o un flujo de trabajo específico del producto.
También significa tener el control de la lógica de la aplicación, credenciales, despliegue y mantenimiento continuo.
LightVela comienza con el Agent y le permite describir su comportamiento en la consola.

| Bot de código estándar | LightVela para Discord |
| --- | --- |
| Escriba comandos y manejadores de eventos | Describa qué debe hacer el Agent |
| Almacene preguntas frecuentes y reglas en código o base de datos | Dé al Agent contexto y límites aprobados |
| Construya programadores para recordatorios | Cree Tareas programadas en la consola |
| Despliegue cambios de comportamiento | Actualice las instrucciones del Agent y revise el resultado |
| Mantenga infraestructura de bot y lógica | Enfóquese en operaciones de comunidad y moderación |

Esto no hace que cada bot personalizado sea innecesario.
Da a la comunidad una forma práctica de lanzar un Agent de Discord útil antes de construir un producto de bot completo.

## Validación y límites

Verifique el escenario con al menos una pregunta conocida, una pregunta de información faltante y una pregunta de moderación sensible.
Revise si el Agent usa la respuesta aprobada, admite incertidumbre y escala en lugar de improvisar.

La guía de configuración de Discord documenta autorización de Bot, interacción de servidor y canal, acceso a contenido de mensaje y mensajes proactivos en la capa de canal.
También documenta una limitación actual alrededor del soporte de chat de grupo.
Si su despliegue depende de menciones amplias de miembros o un modo de conversación multiusuario específico, confirme ese comportamiento en el servidor objetivo antes del lanzamiento público.

Los moderadores humanos permanecen responsables de baneos, informes de abuso, disputas, cambios de política y anuncios que no se han agregado al contexto aprobado.

## Preguntas frecuentes

### ¿Necesito programar un bot de Discord?

No para este caso de uso.
Configura Hermes en LightVela, conecte el canal de Discord e invite el Bot resultante a su servidor.
El código personalizado sigue siendo apropiado para comandos o flujos de trabajo altamente específicos que LightVela no proporciona.

### ¿Puede el Agent responder preguntas sobre reglas del servidor?

Sí, cuando las reglas se incluyen en su contexto aprobado y la instrucción le dice que no invente ni las sobreescriba.
Hágalo indicar a los miembros a un moderador humano cuando la regla es poco clara o el problema es sensible.

### ¿Puede enviar recordatorios de eventos automáticamente?

Sí, la documentación del canal de Discord lista mensajes proactivos como soportados en la capa de canal.
Use [Tareas programadas](../configuration/automation.md) para definir el horario, instrucciones de tarea, ventana de efectividad y canal de notificación.

### ¿Debería el Agent tomar decisiones de moderación?

No.
Úselo para explicaciones, enrutamiento, recordatorios y resúmenes, mientras que los moderadores humanos retienen la autoridad sobre la aplicación y casos sensibles.

## Conclusión

Cree el Hermes Agent, déle contexto de comunidad aprobado, conecte Discord, invite el bot y pruébelo con preguntas reales antes de agregar Tarea programada.
Esa secuencia transforma un Agent de IA privado en un útil asistente enfocado a la comunidad mientras mantiene las reglas del servidor, permisos y límites de escalación humana bajo su control.

Para una versión más enfocada de este patrón, vea [Potencie su Bot de Eventos de Discord con Capacidades Agénticas de IA](./discord-event-agent.md).
