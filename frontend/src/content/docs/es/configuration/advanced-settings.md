# Configuración avanzada

## Resumen

**La Configuración avanzada le permite controlar cómo el Hermes Agent gestiona la seguridad, la memoria y el contexto de la conversación.**
Puede elegir cómo el Agent solicita aprobación para operaciones de alto riesgo, gestionar la memoria persistente, el perfil de usuario y la compresión automática para conversaciones largas, y luego elegir cuándo iniciar la compresión, cuánto contenido reciente conserva y cuántos mensajes recientes permanecen intactos.
Después de guardar el Modo de aprobación, LightVela lee la configuración de nuevo para confirmar el nuevo valor.
Después de guardar una configuración de Gestión de memoria o contexto, LightVela reinicia el servicio relacionado y lee la configuración de nuevo para confirmar el nuevo valor.

![Configuración avanzada en la consola de LightVela](../images/setting-1-en.png)

## ¿Qué cubre esta página?

- Gestión de cómo el Agent solicita aprobación para operaciones de alto riesgo.
- Gestión de la memoria persistente y el perfil de usuario.
- Gestión de la compresión automática para conversaciones largas.
- Configuración del umbral de compresión, la relación de contenido retenido y la cantidad de mensajes recientes protegidos.
- Restaurar los valores predeterminados para el grupo de Seguridad, Memoria o Gestión de contexto.

## Antes de comenzar

1. Confirme que el Agent objetivo está en ejecución.
2. Abra **Agents** y seleccione el Agent que desea configurar.
3. Abra **Configuración avanzada**.

Cuando un Agent no está en ejecución, puede ver sus valores actuales, pero no puede modificarlos.

## Configuraciones disponibles

| Grupo | Configuración | ¿Qué hace? |
| --- | --- | --- |
| Seguridad | Modo de aprobación | Elija Smart, Siempre preguntar o Off para controlar cómo el Agent solicita aprobación para operaciones de alto riesgo. |
| Memoria | Memoria persistente | Permite que el Agent lea y actualice su memoria a largo plazo en conversaciones posteriores. |
| Memoria | Perfil de usuario | Permite que el Agent registre y utilice sus preferencias, estilo de comunicación y hábitos. |
| Gestión de contexto | Compresión automática | Resume contenido más antiguo cuando una conversación larga se acerca al límite de contexto. |
| Gestión de contexto | Umbral de compresión | Establece la relación de uso de contexto que inicia la compresión, desde 0 hasta 1. |
| Gestión de contexto | Relación de retención de compresión | Establece cuánto texto de la conversación reciente se retiene después de la compresión, desde 0.1 hasta 0.8. |
| Gestión de contexto | Mensajes recientes protegidos | Establece la cantidad de mensajes recientes que permanecen intactos durante la compresión, con un mínimo de 1. |

## Cambiar una configuración

### Modo de aprobación

1. En la lista de **Modo de aprobación**, seleccione Smart, Siempre preguntar o Off.
2. Si selecciona Off, lea la advertencia de riesgo y confirme que desea desactivar las aprobaciones.
3. Espere a que la página lea la configuración de nuevo y confirme que muestra el modo que seleccionó.

Cuando las aprobaciones están desactivadas, el Agent ya no solicita su aprobación para operaciones de alto riesgo y la página continúa mostrando una advertencia de riesgo.
Use Off solo en un entorno confiable.

### Cambiar configuraciones

1. Seleccione el interruptor junto a Memoria persistente, Perfil de usuario o Compresión automática.
2. Lea el mensaje de confirmación y confirme el cambio.
3. Espere a que la guarda se complete.

Desactivar Memoria persistente o Perfil de usuario no elimina el contenido existente.
Desactivar Compresión automática mantiene los valores de compresión existentes, pero detiene los resúmenes automáticos del contenido de conversación antiguo.

### Configuraciones numéricas

1. Seleccione el botón de edición junto al valor que desea cambiar.
2. Introduzca un valor dentro del rango permitido.
3. Seleccione Guardar o presione Enter para guardar el valor.
4. Seleccione Cancelar o presione Escape para descartar la edición.

Puede cambiar el umbral de compresión, la relación de retención y la cantidad de mensajes protegidos solo mientras la Compresión automática está activada.

## Restaurar valores predeterminados

Configuración avanzada proporciona **Restaurar valores predeterminados** por separado para los grupos de **Seguridad**, **Memoria** y **Gestión de contexto**.

1. En el grupo que desea restablecer, seleccione **Restaurar valores predeterminados**.
2. Lea el mensaje de confirmación.
3. Confirme la restauración.

Restaurar valores predeterminados elimina los valores personalizados solo del grupo seleccionado y devuelve ese grupo a los valores predeterminados del Hermes Agent.
Restaurar el grupo de Seguridad devuelve el Modo de aprobación a **Smart**.
No afecta a los otros grupos ni elimina la memoria existente del Agent.

## Confirmar el cambio

Después de que una guarda o restauración tenga éxito, la página muestra los valores leídos de nuevo del Agent.
Guardar el Modo de aprobación no reinicia el servicio relacionado, y la página lee el valor directamente.
Guardar o restaurar configuraciones de Memoria y Gestión de contexto reinicia el servicio relacionado y lee la configuración de nuevo.
Después de cambiar la compresión automática, continúe una conversación más larga para confirmar que el Agent sigue las nuevas reglas de gestión de contexto.
Después de cambiar configuraciones de memoria, observe conversaciones posteriores para confirmar que el Agent utiliza la memoria y las preferencias como se espera.

## Preguntas frecuentes

### ¿Por qué no puedo cambiar una configuración?

Primero confirme que el Agent está en ejecución.
Los controles también están temporalmente no disponibles mientras LightVela lee la configuración, guarda un cambio o restaura valores predeterminados.

### ¿Por qué una configuración dice que la versión de mi Agent no la soporta?

La versión que actualmente está ejecutándose en ese Agent no soporta esta configuración.
Use las configuraciones disponibles o revise esta página nuevamente después de actualizar el Agent.

### ¿Por qué no puedo guardar el número que ingresé?

El umbral de compresión debe estar entre 0 y 1.
La relación de retención de compresión debe estar entre 0.1 y 0.8.
La cantidad de mensajes recientes protegidos debe ser un entero de al menos 1.

### ¿Por qué no puedo editar otras configuraciones de compresión después de desactivar Compresión automática?

Esos valores solo aplican mientras la Compresión automática está activada.
Vuelva a activarla antes de cambiarlos.

### ¿Cuándo debo desactivar las aprobaciones?

Cuando las aprobaciones están desactivadas, las operaciones de alto riesgo ya no solicitan su aprobación.
A menos que esté realizando tarea programada deliberada en un entorno confiable, mantenga seleccionado Smart o elija Siempre preguntar.

### ¿Qué debo hacer si la guarda reporta un fallo de reinicio o verificación?

Si cambió una configuración de Memoria o Gestión de contexto, la configuración ya puede estar escrita, pero el reinicio del servicio relacionado o la lectura de la configuración de nuevo no se haya completado.
Si cambió el Modo de aprobación, la configuración ya puede estar escrita, pero la página puede no haber terminado de verificar el valor leído de nuevo.
Recargue la página para verificar el valor mostrado, luego decida si quiere intentarlo de nuevo.
