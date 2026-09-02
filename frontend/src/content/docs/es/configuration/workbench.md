# Workbench

## Resumen

**My Workbench te permite usar un Agent de IA para crear, publicar y administrar sitios web estáticos en LightVela. Elige una plantilla inicial o describe un sitio desde cero, y trabaja con el Agent para perfeccionarlo y publicarlo.**

![Resumen de My Workbench](../images/workbench-01.png)

Después de la implementación, puedes consultar la dirección pública, comprobar el estado actual y administrar tus workbenches desde un solo lugar.

Aviso Beta: My Workbench es una función Beta, por lo que el flujo de generación y publicación puede cambiar a medida que evoluciona.

## Qué hace My Workbench

My Workbench conecta el chat de tu Agent con un flujo administrado para sitios web estáticos.
Puedes iniciar tu propio "worksite" de workbench o elegir una de las plantillas disponibles, interactuar con el Agent para perfeccionarlo y previsualizar tu sitio con un enlace dedicado.

![Página de My Workbench](../images/workbench-02.png)

LightVela administra el proceso de alojamiento, por lo que no necesitas configurar un servidor de alojamiento ni una cuenta en la nube por separado.

## Abrir My Workbench

1. Abre [https://lightvela.ai/agents/](https://lightvela.ai/agents/).
2. En la navegación izquierda, abre My Workbench.

La página de Workbench muestra tu uso actual, las plantillas disponibles y los workbenches existentes.

## Elegir una plantilla inicial

Las plantillas iniciales te ayudan a comenzar con una dirección clara.
Puedes elegir una plantilla según el tipo de sitio web que quieras crear:

- Panel de utilidades limpio: formularios, consultas de información o herramientas internas ligeras.
- Panel de datos: métricas principales, tendencias, resúmenes de negocio o informes diarios.
- Página de campaña: páginas de actividad, registro o canje.
- Presentación personal: portafolios, páginas personales o introducciones de servicios.

Selecciona una plantilla para abrir el chat del Agent con una solicitud preparada.

![Plantillas iniciales](../images/workbench-03.png)

También puedes seleccionar la opción en blanco y dejar que el Agent aclare los requisitos contigo paso a paso.

## Crear un Workbench con el chat del Agent

1. Selecciona una plantilla inicial o comienza con un workbench en blanco.
2. Describe el propósito, la audiencia, el contenido y la dirección visual del sitio web.
3. Responde a las preguntas del Agent mientras aclara los requisitos.
4. Revisa el resultado generado y pide al Agent que haga cambios.
5. Cuando el sitio web esté listo, pide al Agent que publique la versión más reciente.

El flujo actual usa React, TypeScript, Tailwind CSS y bibliotecas de interfaz comunes para generar sitios web.

![Crear un Workbench con el chat del Agent](../images/workbench-04.png)

También se indica al Agent que mantenga el contenido editable, evite datos empresariales ficticios predefinidos y use el almacenamiento local del navegador cuando sea apropiado para datos locales temporales.

## Consultar el estado del Workbench

Cada workbench tiene un estado de implementación para que puedas saber si está listo para visitarlo.

| Estado | Descripción |
| --- | --- |
| Building | El sitio web se está generando o preparando. |
| Publishing | Se está publicando la versión más reciente. |
| Online | El sitio web está disponible en su dirección pública. |
| Update failed | Falló el último intento de generación o publicación. |
| Offline | El sitio web no está disponible o se ha eliminado. |

Cuando un workbench esté online y tenga una dirección pública, selecciona Visit para abrirlo.

![Estado del Workbench y vista previa del sitio](../images/workbench-05.png)

Si el workbench todavía está en Building o Publishing, espera a que termine el proceso y actualiza la página si es necesario.

## Administrar workbenches existentes

La lista de workbenches existentes muestra el nombre del sitio web, la dirección pública, la fecha de creación y el estado actual.

Para actualizar un workbench, vuelve al chat del Agent y describe los cambios que quieres.
Después de revisar los cambios, pide al Agent que publique la versión actualizada.

Para eliminar un workbench:

1. Busca el workbench en la lista.
2. Selecciona la acción de eliminación.
3. Confirma la eliminación.

Eliminar un workbench lo desconecta inmediatamente y elimina sus archivos relacionados.
Esta acción no se puede deshacer.

## Cuota y límites de alojamiento de Workbench

El límite de Workbench depende de tu plan.

- Plan Launch: puedes crear 1 workbench.
- Planes superiores: puedes crear hasta 5 workbenches.

Si alcanzas el límite, elimina un workbench existente antes de crear otro o mejora tu plan.

## Problemas frecuentes

| Problema | Posible causa | Qué hacer |
| --- | --- | --- |
| La página de Workbench solicita iniciar sesión | Tu sesión ha caducado. | Inicia sesión de nuevo y vuelve a abrir My Workbench. |
| No puedes crear otro workbench | Es posible que hayas alcanzado el límite de tu plan. | Comprueba tu uso o elimina un workbench que no utilices. |
| El estado permanece en Building o Publishing | La implementación todavía se está procesando. | Espera un momento y actualiza la página. |
| La acción Visit no está disponible | El workbench todavía no está online. | Espera hasta que el estado cambie a Online. |
| El estado cambia a Update failed | Falló el último intento de generación o publicación. | Revisa la respuesta del Agent, realiza los cambios necesarios y vuelve a intentarlo. |
| Los datos del sitio desaparecen en otro navegador | Los datos se guardaron en el almacenamiento local del navegador. | Usa un servicio backend si el sitio necesita datos compartidos o persistentes. |
| Un workbench eliminado todavía aparece en la lista | La eliminación aún se está procesando. | Espera a que termine la limpieza y actualiza la página. |

## Límites actuales

My Workbench está destinado a crear y alojar sitios web estáticos mediante el chat del Agent.
No proporciona almacenamiento del lado del servidor, bases de datos administradas, gestión persistente de formularios, cuentas compartidas ni servicios backend arbitrarios.
El número de workbenches, el tráfico, el almacenamiento, el tamaño de los paquetes y la cantidad de archivos dependen de tu plan activo.

## Preguntas frecuentes

### ¿Qué tipos de sitios web puedo crear?

Puedes crear paneles, herramientas internas, páginas de campañas, portafolios, páginas de destino y otros sitios web estáticos de frontend.

### ¿Necesito experiencia en programación?

No.
Puedes describir lo que quieres en lenguaje natural y dejar que el Agent te guíe durante los requisitos, la generación y la publicación.

### ¿Puedo actualizar un workbench existente?

Sí.
Vuelve al chat del Agent, describe los cambios, revisa el resultado y pide al Agent que publique la versión actualizada.

### ¿Mi sitio web puede guardar datos?

Los sitios web estáticos pueden guardar temporalmente datos en el navegador actual mediante el almacenamiento local.
LightVela no proporciona almacenamiento persistente del lado del servidor para los sitios de Workbench.

### ¿Necesito una cuenta de alojamiento independiente?

No.
LightVela proporciona el flujo de alojamiento para tu workbench estático.

### ¿Por qué mi workbench no está disponible de inmediato?

La generación y la publicación pueden tardar un poco.
Comprueba el estado actual y espera hasta que cambie a Online antes de abrir la dirección pública.
