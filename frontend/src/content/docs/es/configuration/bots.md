# Gestionar Bots

## Resumen

**Un Bot es un perfil independiente dentro de su Agent de Hermes. El Bot principal se crea junto con el Agent, y cada Bot adicional puede tener sus propios ajustes de modelo, personalidad, memoria, Skills, canales y tareas programadas. Al crear un Bot, elija entre copiar uno existente o empezar con Basic setup. El plan determina cuántos Bots puede crear, incluido el principal.**

> **Disponibilidad en el sitio internacional**
>
> La creación de Bots adicionales se está introduciendo por etapas. Durante este despliegue, la entrada **Create Bot** no se muestra de forma predeterminada en el sitio internacional. Si la entrada no está disponible, continúe usando el Bot principal.

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

Cuando la entrada de creación esté disponible:

1. Seleccione **New Bot**.
2. Introduzca un nombre de Bot de hasta 60 caracteres.
3. Elija un método de creación.
4. Revise el resumen de herencia y seleccione **Confirm creation**.
5. Espere a que termine el aprovisionamiento antes de configurar o usar el nuevo Bot.

La opción de copia disponible depende del Bot seleccionado. Desde el Bot principal, la consola muestra **Copy current (main Bot)**. Desde otro Bot, puede elegir **Clone current** o **Clone main Bot**.

## Elegir un método de creación

| Método | Se hereda | No se hereda |
| --- | --- | --- |
| Copy current, Clone current o Clone main Bot | Modelo, personalidad, Skills, preferencias del usuario y memoria a largo plazo del Bot de origen seleccionado | Conversación actual, historial de chat, tareas programadas, estado de ejecución y conexiones de canales |
| Basic setup | Modelo principal actual y credenciales del Provider del Bot principal, además de las Skills integradas del sistema | Modelos alternativos, otros modelos configurados, personalidad, memoria, Skills instaladas posteriormente en el Bot principal, canales y tareas programadas |

**Basic setup no crea un Bot vacío.** Conserva la configuración mínima del modelo y las Skills integradas necesaria para empezar, mientras mantiene separados el comportamiento personal, la memoria y las integraciones.

## Confirmar el nuevo Bot

Cuando termine el aprovisionamiento:

1. Confirme que aparezca una nueva pestaña de Bot con el nombre introducido.
2. Seleccione el nuevo Bot y compruebe que su modelo y sus Skills coincidan con el método de creación elegido.
3. Abra la página de configuración correspondiente antes de añadir un [Soul](./personality.md), instalar [Skills](./skill.md), conectar canales o crear [tareas programadas](./automation.md).

## Trabajar con varios Bots

Las pestañas de Bot aparecen en la parte superior de la consola del Agent. Seleccione una pestaña antes de cambiar modelos, personalidad, memoria, Skills, canales, tareas programadas o diagnósticos, para trabajar con el Bot previsto.

Cada Bot tiene su propio perfil y sus propios datos. Los cambios realizados en uno no actualizan automáticamente los demás. La función **Chat** de la consola solo está disponible actualmente para el Bot principal, y el mantenimiento a nivel de Agent también debe realizarse desde ese Bot.

Para renombrar un Bot, selecciónelo y edite el nombre mostrado. El nuevo nombre puede tener hasta 60 caracteres.

## Eliminar un Bot

- Eliminar un Bot adicional borra permanentemente su perfil y sus datos.
- Desconecte los canales que pertenezcan a ese Bot antes de eliminarlo.
- Elimine todos los Bots adicionales antes de eliminar el Bot principal.
- Eliminar el Bot principal borra todo el Agent, incluidos los chats, la configuración, las Skills instaladas, las memorias y los datos relacionados.

La eliminación no se puede deshacer. Lea atentamente el mensaje de confirmación e introduzca el nombre de Bot solicitado antes de continuar.

## Solución de problemas

### ¿Por qué no puedo crear otro Bot?

La entrada de creación puede seguir oculta durante el despliegue internacional, la versión actual del Agent puede no admitir varios Bots, el Agent puede no estar en ejecución o el plan puede haber alcanzado su límite de Bots.

### ¿Por qué al Bot copiado le faltan conversaciones, tareas o canales?

Estos elementos no se copian intencionadamente. Vuelva a conectar los canales y cree de nuevo las tareas programadas según sea necesario.

### ¿Por qué Basic setup sigue mostrando un modelo y Skills?

Basic setup hereda el modelo principal actual y las credenciales del Provider del Bot principal, y conserva únicamente las Skills integradas del sistema. No copia los demás modelos, la personalidad, la memoria, las Skills instaladas posteriormente, los canales ni las tareas programadas del Bot principal.
