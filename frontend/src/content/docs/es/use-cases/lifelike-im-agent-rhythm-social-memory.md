# Cómo diseñar un IM Agent más natural: Ritmo de conversación, normas de grupo y memoria social a largo plazo

## Resumen

**"Más realista" no significa impersonar a una persona real. Significa mantener un comportamiento estable, comprensible en la expresión, la respuesta y la colaboración a largo plazo, y se reduce a tres cosas: el ritmo de conversación, las normas de grupo y la memoria social a largo plazo. El ritmo decide cuándo responder brevemente, cuándo desarrollar y cuándo detenerse y esperar confirmación. Las normas de grupo deciden cómo hablar en espacios compartidos, cómo citar el contexto y cómo respetar los límites de los miembros. La memoria social a largo plazo decide si retiene el contexto de la relación confirmado sin convertir cada mensaje en un registro permanente. Implemente esto en capas: el ritmo y las normas son reglas estables a nivel de personalidad, mientras que la memoria guarda solo hechos confirmados y duraderos. Utilice la lista de verificación de conversación natural en esta guía para verificar el diseño.**

![Diseñando un IM Agent más natural con ritmo de conversación, normas de grupo y memoria social](../images/use-case-10-lifelike-im-agent-rhythm-social-memory.png)

## Para quién es este documento

Esta guía es para personas que desean que un IM Agent se sienta más natural y consistente, pero que siga siendo transparente y controlable.

Es útil para asistentes personales, compañeros de estudio, socios de investigación y equipos que diseñan asistentes comunitarios.

La documentación actual de Telegram y WhatsApp trata las conversaciones 1 a 1 como el modo principal soportado, por lo que la sección de normas de grupo es una lista de verificación de diseño y no significa que ningún canal soporte actualmente chats de grupo.

## Decida qué debe mantenerse estable

Divida el comportamiento duradero del Agent en cuatro capas:

| Capa | Responsabilidad | Configuración recomendada |
|---|---|---|
| Personalidad | Rol, voz, principios y límites | SOUL.md |
| Preferencias de relación | Nombre, idioma, nivel de detalle y hábitos de interacción | Perfil de usuario |
| Memoria social | Contexto compartido confirmado, antecedentes del proyecto y acuerdos en curso | Memoria |
| Ritmo actual | Contexto de conversación, longitud y urgencia para esta tarea | Sesión actual y prompt de tarea |

No deje que una emoción temporal o una respuesta accidental cambie la personalidad duradera.

No guarde cada saludo, cada mensaje de un miembro del grupo o una inferencia no confirmada como memoria social a largo plazo.

## Pasos

### 1. Defina un rol natural sin impersonación

Utilice la [guía de personalidad SOUL.md](./im-agent-persona-soul-md.md) para definir el rol, la voz, el nivel de iniciativa y las limitaciones del Agent.

Comience con un breve como este:

    Eres un socio de investigación estable, directo y amable.
    Presenta la conclusión primero, luego añade evidencia y detalles según sea necesario.
    Cuando la solicitud es ambigua, haz la única pregunta aclaratoria más importante.
    Recuerda las preferencias a largo plazo confirmadas, pero no guardes información sensible ni inferencias no confirmadas.
    Eres un asistente de IA. No afirmes ser humano ni pretendas tener experiencias en el mundo real.

Esto mantiene la voz coherente sin construir una confianza engañosa mediante una identidad ficticia.

### 2. Diseñe el ritmo de conversación

Comience con reglas como estas:

- Proporcione una respuesta directa en una a tres frases para una pregunta factual simple.

- Repita el objetivo y desglose los pasos y riesgos antes de manejar una tarea compleja.

- Haga solo la pregunta más importante cuando falta información en lugar de enviar un formulario largo.

- Reduzca la longitud de la respuesta cuando el usuario diga que está ocupado, apurado o solo quiere la conclusión.

- Amplíe el razonamiento cuando el usuario pida una derivación, un tutorial o una retrospectiva.

- Deténgase y espere confirmación antes de acciones externas, sensibles o irreversibles.

Valide el ritmo con tareas reales:

    Dime las tres tareas más importantes de hoy en tres frases.

    Dime la conclusión primero, luego explica por qué las has clasificado de esa manera.

    Esta acción cambia datos externos. Primero dime el impacto y lo que necesita confirmación.

Verifique si el Agent cambia la longitud de la respuesta según la tarea y la preferencia del usuario manteniendo los mismos principios.

### 3. Coloque las preferencias de relación en el perfil de usuario

El perfil de usuario es adecuado para idioma, nombre, zona horaria, nivel de detalle y estilo de trabajo común.

Por ejemplo, un usuario puede decirle a Hermes:

    Recuerda que prefiero respuestas concisas, directas y con la conclusión primero.

Las preferencias de relación deben mejorar la eficiencia de la comunicación, no convertirse en etiquetas de personalidad permanentes que el usuario no pueda cambiar.

Cuando una preferencia cambie, pida a Hermes que actualice o olvide en lugar de editar repetidamente el archivo de personalidad.

### 4. Diseñe la memoria social a largo plazo

Buenos candidatos a memoria a largo plazo incluyen contexto de proyecto confirmado, acuerdos de colaboración duraderos, un nombre preferido estable y preferencias verificadas repetidamente.

Malos candidatos a memoria a largo plazo incluyen contraseñas, códigos de verificación, información de pago, detalles médicos, juicios psicológicos no confirmados y chistes de una sola vez.

Pida a Hermes explícitamente que recuerde u olvide un elemento y revise y limpie periódicamente en [Gestión de Memoria](../configuration/memory.md).

La memoria a largo plazo debe reducir preguntas repetidas sin quitar al usuario el control sobre su información.

### 5. Prepare normas de grupo para espacios compartidos

Telegram y WhatsApp no soportan actualmente chats de grupo, por lo que escriba las normas de grupo como reglas pre-lanzamiento por ahora.

Si un canal objetivo futuro soporte explícitamente grupos, defina al menos:

- Si el Bot responde solo después de una @mención o comando explícito.

- Si un administrador debe activar un mensaje de bienvenida para nuevos miembros.

- Límites de frecuencia para FAQs, resúmenes y recordatorios.

- Cómo distinguir miembros, administradores y mensajes que requieren intervención humana.

- Si los mensajes de los miembros entran en la memoria compartida y cómo se previenen fugas a otros miembros.

- Cómo se pasan a un administrador disputas, quejas, sugerencias de moderación y contenido sensible.

Las normas de grupo pertenecen a las reglas del canal y de operación y no deben depender únicamente de un prompt de personalidad.

### 6. Use automatizaciones para controlar el ritmo proactivo

Los mensajes proactivos necesitan una frecuencia explícita, una ventana de tiempo, un canal objetivo y un método de pausa.

Utilice [Automatizaciones](../configuration/automation.md) para recordatorios personales, resúmenes internos o revisiones periódicas.

Establezca horas de silencio para cada automatización y confirme que el canal objetivo soporte el método de entrega proactiva relevante.

No cree una sensación de compañía mediante mensajes de alta frecuencia y no haga que los recordatorios sean difíciles de detener.

## Lista de verificación de conversación natural

- ¿El Agent respondió primero la pregunta real del usuario?

- ¿Ajustó la longitud según la complejidad de la tarea?

- ¿Hizo una pregunta aclaratoria útil cuando fue necesario?

- ¿Recordó una preferencia confirmada en lugar de adivinar la psicología del usuario?

- ¿Mantuvo claro que es una IA en lugar de implicar una identidad real o experiencias offline?

- ¿Explicó el impacto y esperó confirmación antes de una acción externa?

- ¿Respetó las horas de silencio, solicitudes de rechazo y olvido?

## Preguntas frecuentes

### ¿Significa ser más realista ocultar que el Agent es una IA?

No.

El lenguaje natural, el ritmo estable y el contexto continuo pueden mejorar la experiencia, pero el Agent no debe afirmarse como humano ni inventar experiencias en el mundo real.

### ¿Debo guardar cada conversación como memoria social?

No.

Mantenga solo información confirmada que ayude a la colaboración futura y revise periódicamente la memoria y el perfil de usuario.

### ¿Puedo usar normas de grupo en Telegram y WhatsApp ahora?

La documentación actual de ambos canales dice que los chats de grupo no se soportan, por lo que la sección de normas de grupo es una lista de verificación de diseño y pre-lanzamiento.

Valide personalidad, ritmo, FAQs y recordatorios en conversaciones 1 a 1 primero, luego espere soporte explícito de grupo en el canal objetivo.

### ¿Por qué algunas respuestas del Agent son largas y otras cortas?

La longitud de la respuesta refleja la complejidad de la tarea, el prompt actual, la salida del modelo y las preferencias del usuario.

Establezca una preferencia en el perfil de usuario, o especifique en la solicitud actual que solo quiere la conclusión o una derivación completa.

## Próximos pasos

- [Cómo definir el rol, la personalidad y la voz de un IM Agent con SOUL.md](./im-agent-persona-soul-md.md) - Estabilice el rol, la voz y los límites.

- [Gestión de Memoria](../configuration/memory.md) - Gestione el perfil de usuario y la memoria a largo plazo.

- [Cómo convertir un IM Agent en un Asistente de Servicio al Cliente, Comunidad o Acompañante con Skills](./im-agent-skill-scenarios.md) - Extienda la conversación natural con capacidades concretas.

- [Cómo Configurar un Asistente de IA de Comunidad de Grupo de Telegram](./telegram-group-community-assistant.md) - Revise el límite actual alrededor de las normas de grupo.
