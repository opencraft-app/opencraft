# Automatizaciones

## Resumen

Las automatizaciones permiten que Hermes Agent ejecute trabajos proactivamente según un horario fijo, un intervalo o un esquema de ejecución única, y luego envíe los resultados a los canales de notificación seleccionados. Puede comenzar con una plantilla, o personalizar el nombre, las reglas de ejecución, las instrucciones de la tarea, la ventana de validez y la configuración de notificaciones, y luego continuar gestionando el estado de la tarea desde la lista de tareas.

Al crear o editar una automatización, también puede vincularla a una tarea anterior. Las ejecuciones posteriores utilizarán la salida más reciente completada de la tarea anterior como contexto adicional. Esto es útil para dividir flujos de trabajo como "recopilar información primero, luego resumirla" en múltiples pasos.

Las automatizaciones permiten que Hermes Agent ejecute trabajos específicos según un horario preestablecido o una condición de activación, de modo que no tenga que repetir las mismas operaciones manualmente. Los escenarios típicos incluyen recordatorios programados, generación de informes diarios, seguimiento de noticias y publicación de contenido.

Cada tarea admite programación flexible y reglas de ejecución, de modo que su asistente de IA pueda seguir trabajando proactivamente.

## ¿Qué Cubre Esta Página

- Agregar una automatización
- Vincular una tarea anterior
- Usar plantillas de tareas
- Gestionar automatizaciones

## Agregar una Automatización

- **Nombre**: Nombre del plan de automatización.
- **Programación**: Establezca el ritmo de la tarea. Elija entre días fijos de la semana, intervalo fijo o ejecución única.
- **Instrucciones de la tarea**: Escriba el prompt que el Agent utiliza para llevar a cabo la automatización.
- **Tarea anterior**: Opcional. Una vez vinculada, esta tarea utiliza la salida más reciente completada de la tarea anterior como contexto durante la ejecución.
- **Ventana de validez**: Limite el rango de tiempo en el que la tarea puede ejecutarse. Déjelo vacío para mantenerlo activo las 24 horas.
- **Notificación**: Interruptores opcionales para seleccionar los canales que reciben las notificaciones de ejecución de la tarea.

## Vincular una Tarea Anterior

Una tarea anterior es útil cuando una pieza de trabajo debe dividirse en un flujo multi-paso estable:

1. La primera tarea recopila o genera material base.
2. La segunda tarea se vincula a la primera y continúa organizando, filtrando o reescribiendo basándose en su salida más reciente completada.
3. Las tareas posteriores pueden seguir vinculándose al paso anterior para formar una cadena de procesamiento clara.

Ejemplos comunes:

- Recopilar información candidata cada mañana, luego dejar que una tarea aguas abajo genere un informe diario conciso.
- Resumir el progreso semanal del proyecto primero, luego dejar que una tarea aguas abajo cree una versión para el equipo.
- Resumir los ítems de tareas primero, luego dejar que una tarea aguas abajo los reordene por prioridad y genere el texto de recordatorio.

Vincular una tarea anterior no copia ni fusiona dos configuraciones de tareas. La tarea actual sigue ejecutándose según su propio horario, instrucciones de tarea, ventana de validez y configuración de notificaciones; simplemente recibe la salida más reciente completada de la tarea anterior como contexto adicional. Hermes `context_from` soporta la referencia de uno o más IDs de tarea. Si la página del producto actualmente expone un selector de tarea anterior única, configure solo lo que permite la página. Las tareas en cadena no esperan a tareas anteriores que aún estén ejecutándose en el mismo ciclo del programador, por lo que los horarios de tareas anteriores y aguas abajo deben estar escalonados.

Las instrucciones de la tarea aún necesitan explicar cómo utilizar la salida de la tarea anterior. Por ejemplo: "Basado en las noticias candidatas de la tarea anterior, mantenga solo cinco ítems relacionados con productos de Agents de IA y escriba un resumen en chino". Evite escribir solo "continuar procesando", porque eso hace que sea difícil para la tarea aguas abajo saber qué procesar.

## Plantillas de Tareas

Si no está seguro de qué automatización configurar, haga clic en "Plantillas" para elegir un plan de automatización listo para usar.

## Gestionar Automatizaciones

Después de crear una automatización, puede ver las tareas habilitadas en la página "Automatizaciones".

Desde esta página, puede inspeccionar los detalles de la automatización, editar la tarea, pausarla o eliminarla según sea necesario.

Para tareas vinculadas, verifique si alguna tarea aguas abajo aún depende de la salida más reciente completada de la tarea anterior antes de eliminar la tarea anterior.

## Validación

Después de crear o editar una automatización, no se detenga en "guardado con éxito". Confirme lo siguiente:

1. La tarea aparece en la lista de automatizaciones y su estado coincide con las expectativas.
2. El horario, la ventana de validez y la configuración de notificación son correctos.
3. Si se vincula una tarea anterior, la tarea anterior ya tiene una salida más reciente completada.
4. Después de una ejecución real, inspeccione el registro de ejecución reciente.
5. Verifique si la salida realmente utilizó el resultado de la tarea anterior en lugar de adivinar el contexto faltante.

## Manejo de Fallos Comunes

| Síntoma | Causa Posible | Manejo Sugerido |
|---|---|---|
| La tarea aguas abajo no utilizó el resultado de la tarea anterior | No se vinculó una tarea anterior, la tarea anterior no tiene una salida completada aún, o ambas tareas se ejecutaron en el mismo ciclo del programador | Seleccione nuevamente la tarea anterior, ejecute la tarea anterior con éxito una vez y programe la tarea aguas abajo después de ella |
| La salida se desvía del punto | Las instrucciones de la tarea se basan demasiado en referencias vagas como "acabo de" o "el contenido anterior" | Escriba claramente el objetivo, el alcance, el formato de salida y cómo utilizar la salida de la tarea anterior |
| El flujo de trabajo en cadena se vuelve desordenado con el tiempo | Una tarea maneja demasiados pasos, o las responsabilidades de tareas anteriores y aguas abajo no son claras | Divida el flujo de trabajo para que cada tarea posea un paso claro |
