# Configurar canal - QQ

## Resumen

**El canal de QQ es el que requiere ingresar los parámetros manualmente: cree un bot en la Plataforma Abierta de QQ, obtenga su AppID y AppSecret, y luego péguelos en la sección de Canales de la consola de LightVela. Todo el proceso toma aproximadamente 5–10 minutos. Necesita una cuenta de QQ para actuar como administrador del bot y un modelo configurado (o simplemente los créditos mensuales del modelo incluidos en su plan). En comparación, WeChat, WeCom y Lark se conectan escaneando un código QR. Una vez conectado, el Agent en QQ comparte la misma personalidad y memoria a largo plazo que sus otros canales.**

---

El canal de QQ requiere crear un bot en la Plataforma Abierta de QQ, y luego rellenar el **AppID** y **AppSecret** resultantes en LightVela. Todo el proceso toma aproximadamente 5–10 minutos.

## Esta página cubre

- Registro y creación de un bot en la Plataforma Abierta de QQ

- Obtención del AppID y AppSecret

- Rellenar las credenciales en LightVela para completar la integración

- Chatear con Hermes Agent en QQ

> 💡 **Requisitos previos**
>
> - Una cuenta de QQ (para actuar como administrador del bot)
>
> - Configuración completa de [modelo](./model.md) (o utilice los 100 créditos de prueba incluidos en el plan Launch)
>

---

## Pasos

### 1. Ingrese a la consola

Inicie sesión en LightVela, haga clic en "Mi Hermes" en la esquina superior derecha para ingresar a la consola, y busque el botón "Canales".

### 2. Seleccione el canal de QQ

Haga clic en la lista desplegable y seleccione "QQ". Aparecerá la introducción del canal de QQ debajo.

![](../images/qq1.webp)

### 3. Regístrese en la Plataforma Abierta de QQ

Visite [Plataforma Abierta de QQ](https://q.qq.com/qqbot/openclaw/) y escanee el código QR de la página con la aplicación móvil de QQ para registrarse / iniciar sesión. En la primera visita, el escaneo registrará automáticamente y vinculará la cuenta de QQ actual a la cuenta de la Plataforma Abierta.

Después de escanear en la aplicación móvil de QQ y elegir **Aceptar**, el registro estará completo y entrará en la página de configuración del bot de QQ.

### 4. Cree un bot de QQ

En la página de bots de la Plataforma Abierta de QQ, haga clic en "Crear Bot" para crear un nuevo bot de QQ.

![](../images/qq2.webp)

### 5. Obtenga AppID y AppSecret

Después de crear el bot, localice el **AppID** y **AppSecret** en la página. Haga clic en el botón "Copiar" junto a cada uno y guárdelos en un archivo de notas local.

![](../images/qq3.webp)

> ⚠️ **AppSecret es una credencial sensible**
>
> - Por razones de seguridad, el **AppSecret no se puede ver nuevamente en texto plano — ver de nuevo obliga a reiniciar**. Guárdelo inmediatamente cuando se cree por primera vez.
>
> - No lo pegue en grupos de chat, páginas web públicas ni lo comprometa en un repositorio Git.
>
> - Si se filtra, reinícelo inmediatamente en la Plataforma Abierta de QQ bajo "Reiniciar Secreto", y luego rellene la nueva credencial en LightVela.
>

Después de la creación, QQ agrega automáticamente el bot a su lista de mensajes y envía un mensaje de bienvenida. En este punto, el bot aún no está vinculado a LightVela; enviar un mensaje devolverá "Este bot se ha ido a Marte, intente de nuevo más tarde" — esto es normal, continúe con el siguiente paso.

### 6. Rellene las credenciales en LightVela

De vuelta en la tarjeta "Canales" de la consola, seleccione "QQ" de la lista desplegable, y pegue las credenciales que acaba de copiar:

1. **AppID**: pegue el AppID copiado
2. **AppSecret**: pegue el AppSecret copiado


![](../images/qq4.webp)

### 7. Haga clic en "Agregar y Aplicar"

LightVela utiliza las credenciales anteriores para conectar el bot en la Plataforma Abierta de QQ. Después de unos cuarenta segundos, la página muestra "Guardado con éxito", y aparece una entrada de "QQ" en la lista de "Canales Conectados".

### 8. Encuentre Hermes Agent en QQ

Abra QQ, encuentre el bot que acaba de crear y envíe un mensaje de prueba:

```
Hello
```

Recibirá una respuesta de Hermes Agent en segundos.

![](../images/qq5.webp)

> ✅ **Se admiten menciones en grupos de QQ**
>
> Después de que el vínculo de QQ tenga éxito, LightVela habilita por defecto la política de chat de grupo de QQ de Hermes. Agregue el bot a un grupo de QQ, luego mencione para iniciar una conversación. La política por defecto es `open`, lo que significa que los miembros de los grupos de QQ que contienen el bot pueden mencionarlo para chatear. Los mensajes de grupo regulares sin una mención no disparan una conversación.

## Estado de éxito

- El bot ha sido creado en la Plataforma Abierta de QQ

- Aparece una entrada de "QQ" en la lista de "Canales Conectados" de la consola

- El bot en QQ responde correctamente utilizando IA

- El bot responde en grupos de QQ cuando se menciona

---

## Tipos de mensajes admitidos

Después de la integración, el bot de QQ admite más que texto básico. La lista completa:

| Bot de QQ — tipos de mensajes admitidos y características | Soportado |
| --- | --- |
| Recibir mensajes de texto | ✅ Sí |
| Recibir imágenes | ✅ Sí |
| Recibir archivos | ✅ Sí |
| Recibir mensajes de voz | ✅ Sí |
| Responder con mensajes de texto | ✅ Sí |
| Responder con imágenes | ✅ Sí |
| Responder con archivos | ✅ Sí |
| Contenido de respuesta admite Markdown | ✅ Sí |
| Enviar mensajes proactivamente (por ejemplo, recordatorios programados) | ✅ Sí |
| Citar mensajes históricos | ❌ Aún no |

> ℹ️ **La capacidad real depende del modelo**
>
> La tabla anterior solo refleja lo que el bot de QQ puede recibir y responder a nivel de canal. Si tareas como el procesamiento de imagen / archivo funcionan realmente depende de si el LLM subyacente conectado a Hermes Agent admite esas capacidades.

---

## Preguntas frecuentes

| Síntoma | Causa posible | Resolución |
| --- | --- | --- |
| El bot responde "Mi 'soul' está fuera de línea, por favor verifique su despliegue de servicio de host" | AppID / AppSecret no configurado en LightVela, o las credenciales son incorrectas | Recopie los parámetros de la Plataforma Abierta de QQ, asegúrese de que no haya espacios iniciales / finales, luego rellénelos en LightVela |
| El bot responde "Este bot se ha ido a Marte, intente de nuevo más tarde" | El bot de QQ se ha creado pero aún no está vinculado a LightVela | Siga esta página para rellenar AppID / AppSecret |
| El bot aún no responde después de toda la configuración | Modelo no configurado o créditos de prueba agotados | Verifique el estado de "Modelo Actual" en la tarjeta "1. Modelo" |
| No se puede encontrar el AppSecret | El AppSecret solo es visible en el momento de la creación | Haga clic en "Reiniciar Secreto" en la Plataforma Abierta de QQ para generar un nuevo valor, luego rellénelo en LightVela |
| AppSecret filtrado | — | Vaya a "Reiniciar Secreto" en la Plataforma Abierta de QQ, y rellene el nuevo AppSecret en LightVela |
| Código QR expirado | No se escaneó dentro de la ventana de validez | Cierre el diálogo y haga clic nuevamente en "Autorizar Acceso" |

---

## Notas del canal

- **Tipos de mensajes**: Texto, imágenes, archivos, voz y más — vea "Tipos de mensajes admitidos" arriba

- **Soporte para chat en grupo**: Las menciones de grupo se habilitan por defecto después del vínculo. La consola aplica la política `open`, permitiendo que los miembros de los grupos de QQ que contienen el bot lo mencionen para chatear. Para restringir el acceso a grupos seleccionados, cambie la configuración de la instancia de Hermes a `allowlist` y mantenga la lista de autorización allí; la tarjeta de canal aún no expone este interruptor

- **Gestión de credenciales**: El AppSecret solo es visible en texto plano en el momento de la creación; si se pierde o se filtra, debe reiniciarse

---

## Próximos pasos

- [Configurar canal - WeCom](./channel-wecom.md) — Escenarios de colaboración empresarial y oficina interna

- [Configurar canal - Lark](./channel-feishu.md) — Escenarios de oficina con texto rico y chat en grupo

- [Configurar Skills](./skill.md) — Extender las capacidades de Hermes Agent
