# Configurar modelos

## Resumen

**Configurar un modelo es opcional: tu plan incluye créditos mensuales para modelos, por lo que una vez que creas un Agent y conectes un canal puedes empezar a hablar inmediatamente y solo configurar un modelo después de que se agoten esos créditos. La sección de Modelos de la consola ofrece tres opciones: Plan de Codificación de Modelos (mensual o anual, ideal para uso intensivo), API de Modelo (pago a medida, ideal para uso ligero o pruebas) y Modelo personalizado (conectar un endpoint compatible con OpenAI). Las tres requieren tu propia clave API del proveedor correspondiente. Los pasos son: elegir una fuente, elegir un modelo específico, pegar la clave API y establecerla como predeterminada. Puedes cambiar los modelos más tarde sin perder memoria. Las claves API son credenciales sensibles — nunca las publiques en grupos de chat ni en páginas públicas, nunca las comprometas en un repositorio Git y revoca o rota inmediatamente la clave en la consola del proveedor si se filtra.**

---

Esta página explica cómo configurar un modelo de lenguaje grande para Hermes Agent, incluyendo las diferencias entre los tres métodos de configuración, cómo obtener una Clave API, los pasos de configuración en la consola, los modelos compatibles y orientación para la selección de modelos.

> 💡 **La configuración es opcional**
>
> El plan de Lanzamiento incluye 100 créditos de prueba. Después de crear Hermes Agent y conectar un canal, puedes empezar a chatear directamente. Configura un modelo después de que se agoten los créditos.

---

## ¿Qué cubre esta página

- Diferencias entre los tres métodos de configuración (Plan de Codificación / API / Modelo Personalizado)

- Cómo obtener una Clave API

- Pasos de configuración en la consola

- Cambio de modelos

- Modelos compatibles

- Orientación para la selección de modelos


---

## Tres métodos de configuración

El menú desplegable de nivel superior en la tarjeta "Modelo" de la consola ofrece tres opciones:

| Método | Modo de facturación | Fuente de la Clave API | Caso de uso |
| --- | --- | --- | --- |
| Plan de Codificación de Modelo | Mensual / anual | Proveedor | Uso de alta frecuencia |
| API de Modelo | Pago a medida | Proveedor | Uso de baja frecuencia o prueba |
| Modelo personalizado | Depende del endpoint | Proporcionado por el usuario | Conectar modelos internacionales o endpoints compatibles con OpenAI |

> ⚠️ **Prepara tu propia Clave API**
>
> Los tres métodos requieren tu propia Clave API. Regístrate con el proveedor correspondiente y crea una Clave primero.

---

## Proceso general para obtener una Clave API

Las interfaces de los proveedores difieren, pero el proceso es generalmente el mismo:

1. **Visita el sitio web del proveedor**: Después de seleccionar un modelo en la tarjeta de modelo de la consola, aparece el enlace "Obtener CLAVE API" debajo. Haz clic para abrir el sitio web del proveedor

2. **Regístrate o inicia sesión**: La mayoría de las plataformas chinas soportan el inicio de sesión con WeChat o número de teléfono

3. **Completa la verificación de identidad**: Los proveedores de modelos chinos generalmente requieren verificación de identidad antes de permitir llamadas API

4. **Abre la página de gestión de claves API**: Generalmente bajo "Consola → Gestión de API / Gestión de Claves / Credenciales"

5. **Crea una nueva Clave**: Nombra la Clave (por ejemplo, `LightVela`) y cópiala inmediatamente después de crearla. La mayoría de las plataformas muestran la Clave completa solo una vez

6. **Vuelve a LightVela y pega la Clave**


> ⚠️ **Las claves API son credenciales sensibles**
>
> No envíes claves a grupos de chat, no las publiques en páginas web ni las comprometas en repositorios Git. Si se filtra una clave, revócala o restablecela inmediatamente en la consola del proveedor.

---

## Configurar en la consola

Ingresa a la consola y abre el botón "Modelo".

### Pasos de configuración

1. **Elige fuente** (menú desplegable de nivel superior): API de Modelo / Plan de Codificación de Modelo / Modelo Personalizado

2. **Elige modelo específico** (menú desplegable de nivel inferior): Los modelos disponibles se muestran según la fuente seleccionada anteriormente

3. **Introduce la Clave API**: Pega la Clave que obtuviste. El icono de ojo a la derecha alterna la visibilidad

4. **Haz clic en "Agregar como predeterminado"**

5. Aparece el registro correspondiente en la lista de "Modelo actual", indicando que la configuración fue exitosa


![](../images/5-1.webp)

### Campos adicionales para modelos personalizados

Al seleccionar "Modelo Personalizado", generalmente necesitas rellenar los siguientes campos además de la Clave API:

- **URL base**: La dirección de la API del servicio del modelo, por ejemplo `https://api.openai.com/v1`

- **Nombre del modelo**: El identificador del modelo, por ejemplo `gpt-4o` o `claude-3-5-sonnet-20241022`


Los campos reales dependen de la interfaz de la consola.

> 💡 **Cómo configurar modelos personalizados (como OpenAI GPT, Google Gemini, etc.)**
>
> Además de los modelos comunes listados en la consola, como MiniMax, Kimi y Zhipu GLM, los usuarios también pueden configurar OpenAI GPT, Google Gemini, Claude u otros modelos no mostrados en la lista mediante "Modelo Personalizado".

---

## Cambiar modelos

### Cómo cambiar

Ejecuta nuevamente los pasos de configuración. La nueva acción "Agregar como predeterminado" sobrescribe la configuración anterior.

> ⚠️ **Solo un modelo está activo**
>
> Actualmente, cada Hermes Agent puede tener solo un modelo activo. Para comparar el rendimiento de diferentes modelos, configura y prueba ellos por separado.

### Impacto en la memoria

Cambiar modelos no afecta la memoria de la conversación. La memoria pertenece a Hermes Agent en sí mismo; el modelo solo se encarga de generar respuestas.

---

## Modelos compatibles

### Plan de Codificación de Modelo (mensual)

| Nombre | Proveedor |
| --- | --- |
| Zhipu AI (GLM Internacional - Plan de Codificación) | Zhipu AI |
| Kimi Plan de Codificación | Moonshot AI |
| Xiaomi Token Plan | Xiaomi |
| Bailian Plan de Codificación | Alibaba Cloud Bailian |
| Volcano Engine Ark Plan de Codificación | Volcano Engine (ByteDance) |

### API de Modelo (pago a medida)

| Nombre | Proveedor |
| --- | --- |
| OpenAI | OpenAI |
| Anthropic | Anthropic |
| Google Gemini | Google |
| OpenRouter | OpenRouter |
| DeepSeek | DeepSeek |
| Bailian (Qwen) | Alibaba |
| MiniMax (Internacional) | MiniMax |
| Moonshot AI (Kimi Internacional) | Moonshot |
| Zhipu AI (GLM Internacional) | Zhipu |
| Volcano Engine (Doubao) | ByteDance |
| Xiaomi MiMo | Xiaomi |

### Modelos personalizados

Cualquier endpoint compatible con el protocolo OpenAI Chat Completions puede conectarse, incluyendo:

- Modelos auto-hospedados: vLLM, Ollama, LM Studio y otros servicios que exponen endpoints compatibles con OpenAI

- Plataformas de agregación: OpenRouter, etc.


---

## Orientación para la selección

Direcciones de selección según diferentes prioridades:

| Prioridad | Dirección sugerida |
| --- | --- |
| Cuota gratuita | Muchos proveedores ofrecen cuota gratuita para nuevas cuentas; empieza con una prueba |
| Procesamiento de contexto largo | Elige modelos con ventanas de contexto más grandes (como Moonshot AI) |
| Velocidad de respuesta | Los proveedores varían significativamente; confía en la experiencia real |
| Comprensión china | Los modelos chinos generalmente soportan el chino mejor |
| Uso de alta frecuencia | Elige el Plan Mensual de Codificación del proveedor correspondiente |

Recomendación: usa los créditos de prueba del plan de Lanzamiento para varias conversaciones primero. Después de confirmar que Hermes Agent funciona normalmente, decide qué modelo usar.

---

## Preguntas frecuentes

| Problema | Posible causa | Solución |
| --- | --- | --- |
| "Modelo actual" sigue vacío después de introducir una Clave | Formato de la clave incorrecto o contiene espacios | Copia y pega nuevamente; confirma que no hay espacios al inicio o al final |
| Sin respuesta durante mucho tiempo después de enviar un mensaje | El saldo del proveedor es insuficiente o la clave está deshabilitada | Revisa el saldo y el estado de la clave en la consola del proveedor |
| Contenido de respuesta desordenado o sin sentido | El endpoint del modelo personalizado no es compatible con el protocolo OpenAI | Verifica la disponibilidad del endpoint con otro cliente compatible con OpenAI primero |
| "Tiempo de espera de respuesta del modelo" | Límite de tasa del proveedor o inestabilidad de red | Intenta de nuevo más tarde o cambia a otro proveedor |
| No estás seguro de la URL base de un modelo personalizado | — | Revisa la documentación de la API del servicio correspondiente; generalmente es `https://xxx.com/v1` |

### Error de conversación "HTTP 401:InvalidAuthentication" o errores 401 similares

Si aparece `HTTP 401:InvalidAuthentication` u otro error `401 xxx` durante una conversación con OpenClaw, generalmente se debe a una de las siguientes:

1. La Clave API del modelo está configurada incorrectamente;

2. La Clave API del Plan de Codificación se confunde con una Clave API de modelo regular;

3. Se selecciona incorrectamente la versión nacional o internacional de un proveedor de modelos.


Cuando esto ocurre, revisa nuevamente la configuración del modelo.

---

## Próximos pasos

- [Configurar Canal - WeChat](./channel-wechat.md)

- [Configurar Canal - Telegram](./channel-telegram.md)

- [Configurar Canal - WhatsApp](./channel-whatsapp.md)

- [Configurar Canal - Discord](./channel-discord.md)

- [Configurar Canal - Slack](./channel-slack.md)

- [Configurar Canal - QQ](./channel-qq.md)

- [Configurar Canal - WeCom](./channel-wecom.md)

- [Configurar Canal - Lark](./channel-feishu.md)

- [Configurar Skills](./skill.md)
