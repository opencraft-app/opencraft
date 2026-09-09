# Almacenamiento en la Nube

## Resumen

**El almacenamiento en la nube es el espacio de trabajo de archivos de su Hermes Agent. Puede guardar materiales de tareas en un solo lugar, subir y organizar archivos o descargar lo que necesita localmente, todo sin salir de LightVela. La capacidad proviene de su plan: Launch incluye 50 GB de almacenamiento en la nube dedicado y Cruise ofrece más. Los archivos que el Agent lee y escribe mientras ejecuta tareas también viven aquí, lo que lo convierte tanto en su biblioteca de documentos como en el directorio de trabajo del Agent.**

---

El almacenamiento en la nube es el espacio de trabajo de archivos para su Hermes Agent. Úselo para guardar los archivos que necesita un Agent en un solo lugar, y luego suba, organice, descargue o elimine ellos desde la consola del Agent sin salir de LightVela.

## ¿Qué cubre esta página?

- Abrir el Almacenamiento en la Nube de su Agent
- Subir, crear y organizar archivos y carpetas
- Descargar, renombrar y eliminar archivos
- Verificar que el espacio de trabajo esté listo para su Agent

> **Bueno para saber:** El Almacenamiento en la nube pertenece al Agent seleccionado. Abra el mismo Agent cada vez que desee gestionar los archivos que puede utilizar.

## ¿Cuándo usar Almacenamiento en la Nube?

El Almacenamiento en la nube es útil cuando un Agent necesita material de referencia, documentos de trabajo o un lugar ordenado para guardar archivos creados durante una tarea. Por ejemplo, puede subir un breve de proyecto antes de pedirle al Agent que lo resuma, o crear carpetas para separar trabajos recurrentes.

Es diferente del contexto guardado del Agent. Para gestionar lo que un Agent recuerda entre conversaciones, consulte [Memory](./memory.md).

## Antes de comenzar

1. Asegúrese de poder abrir el Agent con el que desea trabajar.
2. Prepare los archivos que desea agregar. Las subidas y descargas individuales individuales soportan archivos de hasta 1 GB.
3. Decida una estructura de carpetas simple si está agregando varios archivos relacionados.

## Abrir Almacenamiento en la Nube

1. Abra **Agents** y seleccione el Agent cuyos archivos desea gestionar.
2. Abra su sección de **Cloud Storage** o **Files**.
3. Espere a que la lista de archivos cargue antes de comenzar una subida o una acción de carpeta.

![La lista de archivos de Almacenamiento en la nube en la consola de LightVela](../images/cloud-storage-overview-en.png)

Si la lista no carga, refresque la página e intente de nuevo. Si el problema persiste, utilice [Diagnostics](./diagnostics.md) para revisar los registros recientes del Agent antes de realizar un cambio mayor.

## Subir archivos y crear carpetas

### Subir un archivo

1. Seleccione **Upload**.
2. Elija uno o varios archivos desde su computadora.
3. Mantenga la página abierta hasta que la subida termine, luego confirme que el archivo aparezca en la carpeta actual.

Use nombres claros para que tanto usted como el Agent puedan reconocer el archivo más tarde. Si un archivo es demasiado grande, reduzca su tamaño por debajo de 1 GB o divídalo antes de subirlo.

### Crear una carpeta o archivo

1. En la carpeta donde desea el nuevo elemento, seleccione **New folder** o **New file**.
2. Ingrese un nombre descriptivo.
3. Confirme la acción, luego abra el nuevo elemento para continuar trabajando.

Una estructura pequeña suele ser suficiente: una carpeta para el material de origen, una para el trabajo en progreso y una para archivos finalizados. Evite carpetas anidadas profundamente a menos que realmente faciliten la navegación del proyecto.

## Gestionar archivos existentes

Seleccione un archivo o carpeta para utilizar las acciones disponibles en la lista de archivos:

- **Open** una carpeta para navegar por su contenido.
- **Download** un archivo cuando necesite una copia local.
- **Rename** un elemento para hacer más claro su propósito.
- **Delete** archivos o carpetas que ya no necesita.

> **Precaución:** Eliminar un elemento lo elimina del Almacenamiento en la nube de este Agent. Descargue cualquier cosa que pueda necesitar más tarde antes de eliminarlo.

Si utiliza herramientas que crean archivos ocultos, active la vista de archivos ocultos solo cuando necesite inspeccionarlos. Mantener esa vista apagada facilita la gestión diaria de archivos.

## Verificar el espacio de trabajo

Está listo para usar Almacenamiento en la nube cuando:

- el archivo o carpeta aparece en la ubicación esperada;
- puede abrir o descargar el archivo con éxito; y
- los nombres de carpeta hacen claro qué material pertenece a la tarea actual.

Ahora puede volver a [Chat](./agent-chat.md) y decirle al Agent qué desea hacer con los archivos. Para trabajos repetibles, combine las mismas instrucciones con [Tareas programadas](./automation.md) o [Skills](./skill.md).

## Preguntas frecuentes

### ¿Por qué no puedo subir o descargar un archivo?

Primero verifique que el archivo no sea mayor a 1 GB y que su conexión sea estable. Refresque la vista de Almacenamiento en la nube, luego intente la acción de nuevo. Si sigue fallando, recopile información reciente en [Diagnostics](./diagnostics.md).

### ¿Puedo usar los archivos de un Agent con otro Agent?

El Almacenamiento en la nube se gestiona desde la consola del Agent seleccionado. Abra el Agent que desea utilizar y agregue los archivos allí para que el espacio de trabajo permanezca claro e intencional.

### ¿Elimina la eliminación de un archivo el archivo de mi computadora?

No. Eliminar desde Almacenamiento en la nube elimina la copia gestionada para ese Agent. No elimina el archivo original en su computadora.

## Próximos pasos

- Use [Chat](./agent-chat.md) para trabajar con los archivos que ha preparado.
- Revise [Memory](./memory.md) cuando el Agent debe retener contexto, no solo archivos.
- Use [Diagnostics](./diagnostics.md) si las acciones de almacenamiento fallan repetidamente.
