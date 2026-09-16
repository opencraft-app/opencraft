# Diagnóstico

## Resumen

**El centro de diagnóstico es donde solucionas problemas con un Hermes Agent que no funciona correctamente. En un solo lugar puedes ver y exportar registros recientes, restablecer la configuración del modelo o reinstalar el Agent manteniendo tus datos. Cuando el Agent deja de responder, responde de forma extraña o falla la conexión con un canal, revisa aquí primero: lee los registros para determinar si se trata de una llamada al modelo fallida, un canal caído o un error de Skill, y luego realiza la acción correspondiente. La reinstalación preserva tus datos, por lo que la memoria acumulada no se pierde.**

---

El diagnóstico te ayuda a investigar un Agent que no se comporta como se espera. Desde un solo lugar, puedes revisar los registros recientes del Hermes Agent, exportarlos para compartirlos, restablecer la configuración del modelo o reinstalar el Agent manteniendo sus datos.

## ¿Qué cubre esta página?

- Ver y exportar registros recientes
- Restablecer una configuración de modelo rota
- Reinstalar un Agent manteniendo sus datos
- Saber cuándo usar opciones de recuperación y cuándo pedir ayuda

> **Usa el Diagnóstico deliberadamente:** Empieza con los registros y la acción más pequeña y segura. Restablecer la configuración o reinstalar un Agent se reserva mejor para problemas persistentes.

## Antes de empezar

1. Abre el Agent que tiene problemas.
2. Anota lo que sucedió, cuándo comenzó y si afecta a Chat, un canal conectado o una tarea específica.
3. Si un modelo falla, revisa la configuración actual en [Configurar Modelos](./model.md) antes de hacer cualquier restablecimiento.

## Abrir Diagnóstico

1. Abre **Agents** y selecciona el Agent afectado.
2. Abre la sección **Diagnóstico**.
3. Selecciona un rango de tiempo para los registros recientes: 1, 3, 6, 12 o 24 horas.
4. Selecciona **Actualizar** para cargar los registros.

![Diagnóstico en la consola de LightVela](../images/diagnostics-overview-en.png)

Empieza con el período más corto útil. Una ventana de registro más estrecha facilita conectar un error con la acción que lo provocó.

## Revisar y exportar registros

Usa la salida de registro para confirmar si el Agent estaba funcionando e identificar el momento de un fallo. Puedes exportar el rango de registro actual como un archivo cuando necesites mantener un registro o compartirlo con tu contacto de soporte.

Al reportar un problema, incluye:

- el tiempo aproximado en que ocurrió;
- lo que pediste al Agent que hiciera;
- el rango de registro seleccionado; y
- el mensaje de error relevante, sin incluir secretos ni claves de API.

## Reparar una configuración de modelo

Si el Agent no puede usar el modelo configurado y el problema persiste después de verificar el proveedor, la selección de modelo y las credenciales, selecciona **Restablecer configuración de modelo** en Diagnóstico.

Esto restaura la configuración del modelo del Hermes Agent para que puedas configurarlo de nuevo. Después de que termine:

1. Vuelve a [Configurar Modelos](./model.md).
2. Añade o selecciona el modelo que deseas usar.
3. Envía un mensaje de prueba breve en [Chat](./agent-chat.md).

> **Precaución:** Restablece la configuración del modelo solo cuando estés listo para configurar de nuevo un modelo funcional. No es la primera respuesta ante un problema temporal de proveedor o de red.

## Reinstalar un Agent manteniendo los datos

Para un problema que persiste después de revisar los registros y la configuración del modelo, el Diagnóstico ofrece **Reinstalar Agent (mantener datos)**. Esto inicia el proceso de reinstalación del Hermes Agent mientras preserva sus datos.

1. Lee la descripción de la acción en Diagnóstico.
2. Inicia la reinstalación y mantén la página abierta mientras cambia el estado.
3. Cuando termine, recarga la consola del Agent.
4. Prueba una tarea simple en Chat, luego revisa Almacenamiento en la Nube y tu configuración habitual.

![Diálogo de confirmación de reinstalación del Agent](../images/diagnostics-reinstall-en.webp)

Un Agent puede estar brevemente no disponible durante el mantenimiento. Evita iniciar otra acción de reparación mientras la reinstalación aún esté en progreso.

## Copia de seguridad y recuperación, cuando esté disponible

Algunas cuentas muestran un panel **Copia de seguridad y recuperación** en Diagnóstico. Si está disponible para ti, sigue las instrucciones mostradas en tu consola para crear una copia de seguridad o restaurar un paquete de respaldo de Hermes compatible. No asumas que esta opción está disponible para cada Agent o cuenta.

Antes de restaurar, guarda una copia de cualquier archivo que no puedas reemplazar. [Almacenamiento en la Nube](./files.md) es un buen lugar para revisar primero los archivos actuales del Agent.

## Verificar la solución

El problema probablemente se haya resuelto cuando:

- los registros recientes se cargan sin un fallo repetido;
- el Agent puede responder a una prueba simple en Chat; y
- el modelo y los archivos que esperas están disponibles de nuevo.

Si reaparece el mismo error, exporta los registros relevantes y registra la hora de la próxima ocurrencia antes de escalarlo.

## Preguntas frecuentes

### ¿Qué rango de registro debo elegir?

Elige el rango más corto que incluya el problema. Usa un rango más largo solo cuando el problema comenzó anteriormente o ocurre de forma intermitente.

### ¿La reinstalación borrará los datos de mi Agent?

La acción de Diagnóstico se etiqueta como **Reinstalar Agent (mantener datos)** y está diseñada para preservar los datos. Sin embargo, evita interrumpir el proceso de mantenimiento y verifica el Agent después de que complete.

### ¿Debo restablecer la configuración del modelo para cada error de modelo?

No. Primero revisa [Configurar Modelos](./model.md) para el modelo y las credenciales seleccionados, luego confirma que el proveedor esté disponible. Restablece solo cuando la configuración misma necesita ser reconstruida.

## Siguientes pasos

- Vuelve a [Chat](./agent-chat.md) para probar el Agent reparado.
- Revisa [Configurar Modelos](./model.md) o [Cambiar de Modelo](./multiple-models.md) para problemas relacionados con el modelo.
- Revisa [Almacenamiento en la Nube](./files.md) si una tarea depende de archivos que faltan o son inaccesibles.
