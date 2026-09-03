# Chat

## Resumen

**La página de Chat es una ventana de mensajería integrada en la consola de LightVela, que le permite hablar directamente con su Hermes Agent sin conectar ningún canal externo — útil para verificar que el Agent funciona correctamente después de configurar un modelo. Comparte el mismo Agent, la misma personalidad y la misma memoria a largo plazo que sus canales de mensajería externos, por lo que una preferencia que mencione aquí también se aplica en esos canales, y viceversa.**

---

Abra la página "Chat" para interactuar con su Hermes Agent a través de una ventana de chat.

> ℹ️ **Nota**
>
> La guía de interfaz de AgentChat está actualmente principalmente en chino; la localización completa está en camino.

![La página de Chat en la consola de LightVela](../images/chat-overview-en.png)

---

## Memoria de conversación

El Hermes Agent puede iterar y evolucionar por sí mismo a medida que continúan las conversaciones. Consulte la página "Memoria" para obtener más información sobre su memoria.

![](../images/agentchat-2-global-en.webp)

### Cómo funciona la memoria

El Hermes Agent construye memoria a largo plazo automáticamente mediante dos mecanismos:

- **Compresión de contexto**: destila la información clave de conversaciones largas en memoria de larga duración.

- **Nodos de memoria clave**: captura automáticamente preferencias personales, hábitos de uso e información relacionada con proyectos que vale la pena reutilizar más tarde.

### Cómo se almacena la memoria

La memoria se persiste en dos tipos de documentos:

- `MEMORY.md`: información del proyecto, entorno de ejecución y convenciones de colaboración

- `USER.md`: preferencias personales del usuario, hábitos de uso y estilo de comunicación

Solo se retiene el contenido de valor a largo plazo, de modo que el Hermes Agent pueda dar respuestas coherentes y personalizadas en conversaciones posteriores.

---
