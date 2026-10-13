# Gestionar Bots

## Resumen

**Un Bot es un perfil independiente dentro de su Agent de Hermes. El Bot principal se crea junto con el Agent, y cada Bot adicional puede tener sus propios ajustes de modelo, personalidad, memoria, Skills, canales y tareas programadas. Al crear un Bot, elija entre copiar uno existente o empezar con Basic setup. El plan determina cuántos Bots puede crear, incluido el principal.**


## Contenido de esta página

- La relación entre un Agent de Hermes y sus Bots.
- Crear un Bot copiando uno existente o usando Basic setup.
- Qué hereda cada método de creación.
- Cambiar, renombrar y eliminar Bots.

## Antes de empezar

1. Confirme que el Agent de Hermes esté en ejecución.
2. Confirme que el plan permita agregar otro Bot. El límite incluye el Bot principal.
3. Abra **Agents** y seleccione el Agent que desea gestionar.

## Crear un Bot

Para crear otro Bot, seleccione **Nuevo bot** si la opción está disponible y el plan tiene capacidad. Introduzca **Nombre** (obligatorio) y **Descripción** (opcional), y ajuste la apariencia si lo necesita. La opción predeterminada es **Crear en blanco**. Si hay Bots válidos para copiar, abra **Avanzado** y seleccione un Bot de origen concreto. Para copiar el Bot que está usando, abra **Gestionar bot → Copiar Bot**; el formulario selecciona ese origen. Revise el origen, seleccione **Crear** y espere a que termine.

El control para cerrar y las opciones avanzadas de copia solo aparecen cuando hay Bots de origen válidos. La primera configuración sin origen debe completarse. Los controles de apariencia cambian el color, la forma y los accesorios; no seleccionan el origen de la copia.

## Elegir un método de creación

| Método | Se hereda | No se hereda |
| --- | --- | --- |
| Copiar Bot | Modelo, personalidad, Skills, preferencias del usuario y memoria a largo plazo del Bot de origen seleccionado | Conversación actual, historial de chat, tareas programadas, estado de ejecución y conexiones de canales |
| Crear en blanco | Modelo principal actual y credenciales del Provider del Bot principal, además de las Skills integradas del sistema | Modelos alternativos, otros modelos configurados, personalidad, memoria, Skills instaladas posteriormente en el Bot principal, canales y tareas programadas |

**Crear en blanco no crea un Bot vacío.** Conserva la configuración mínima del modelo y las Skills integradas necesaria para empezar, mientras mantiene separados el comportamiento personal, la memoria y las integraciones.

## Confirmar el nuevo Bot

Tras la creación, compruebe el nombre del nuevo Bot en el selector, abra su chat web y envíe un mensaje breve de prueba. Si falla la creación o la configuración inicial, siga la opción de reintento mostrada y revise la lista de Bots antes de crear otro. Si no recibe respuesta, compruebe el estado del Bot y los créditos o la configuración del modelo.

## Trabajar con varios Bots

Seleccione el avatar del Bot deseado en la barra de Bots. En pantallas estrechas, abra primero el panel de navegación. Compruebe su nombre antes de cambiar modelos, memoria, Skills, canales o tareas programadas. El chat web y la lista de conversaciones pertenecen al Bot seleccionado; los Bots adicionales también pueden usar el chat web. No necesita conectar un canal de mensajería para usarlo.

Para renombrar un Bot, selecciónelo y edite el nombre mostrado. El nuevo nombre puede tener hasta 60 caracteres.

## Eliminar un Bot

- Eliminar un Bot adicional borra permanentemente su perfil y sus datos.
- Desconecte los canales que pertenezcan a ese Bot antes de eliminarlo.
- Elimine todos los Bots adicionales antes de eliminar el Bot principal.
- Eliminar el Bot principal borra todo el Agent, incluidos los chats, la configuración, las Skills instaladas, las memorias y los datos relacionados.

La eliminación no se puede deshacer. Lea atentamente el mensaje de confirmación e introduzca el nombre de Bot solicitado antes de continuar.

## Solución de problemas

### ¿Por qué no puedo crear otro Bot?

Compruebe si la cuenta tiene habilitada la creación de varios Bots, si el Agent está en ejecución, si el plan tiene capacidad y si hay otra creación o eliminación en curso.

### ¿Por qué al Bot copiado le faltan conversaciones, tareas o canales?

Estos elementos no se copian intencionadamente. Vuelva a conectar los canales y cree de nuevo las tareas programadas según sea necesario.

### ¿Por qué Basic setup sigue mostrando un modelo y Skills?

Basic setup hereda el modelo principal actual y las credenciales del Provider del Bot principal, y conserva únicamente las Skills integradas del sistema. No copia los demás modelos, la personalidad, la memoria, las Skills instaladas posteriormente, los canales ni las tareas programadas del Bot principal.
