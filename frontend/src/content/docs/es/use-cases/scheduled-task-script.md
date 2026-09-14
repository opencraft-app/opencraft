# Ejecutar tareas de script en LightVela

Las tareas de Script son una aplicación práctica para los agentes alojados en la nube porque pueden ejecutar scripts de Bash o Python según una programación sin llamar a un modelo de IA.
Úselas cuando tenga una comprobación de sistema recurrente con reglas claras y predecibles.
Los usuarios las han utilizado para alertas de uso de disco y para comprobaciones que detectan archivos ausentes u obsoletos.

## Problemas comunes que los scripts pueden resolver

Muchos problemas pequeños del sistema se pueden detectar con una comprobación sencilla.
Sin embargo, estas comprobaciones suelen olvidarse hasta que algo deja de funcionar.

- El uso de disco crece sin que se note.
- Una exportación diaria deja de generar archivos nuevos.
- Un archivo de copia de seguridad queda obsoleto.
- Un problema se descubre solo después de afectar a otro trabajo.

En LightVela puede configurar una tarea de Script con código Bash o Python, una programación, una ventana de tiempo efectiva y un canal de entrega.
La tarea no llama a un modelo, por lo que no consume tokens de modelo.
La documentación de [Tareas programadas](https://lightvela.ai/docs/configuration/automation?from=social_x) explica las opciones de programación y notificación disponibles.

## Caso 1: Alerta de uso de disco

Cada mañana, una tarea de Script de Bash comprueba el espacio de disco disponible y solo informa cuando el uso alcanza el 80 %.

Script:

```bash
used=$(df -P / | awk 'NR==2 {gsub("%", "", $5); print $5}')

if [ "$used" -ge 80 ]; then
  echo "Disk usage alert: ${used}% used."
fi
```

![Crear una tarea de script recurrente para una alerta de uso de disco](../images/scheduled-task-script-1.png)

Si el uso de disco está por debajo del umbral, el script no imprime nada y no se envía ninguna notificación.
Esto mantiene las comprobaciones rutinarias silenciosas salvo que algo requiera atención.

## Caso 2: Exportación ausente u obsoleta

Cada tarde de día laborable, una tarea de Script de Python comprueba si el archivo de exportación más reciente existe y se ha actualizado en las últimas 24 horas.

Script:

```python
from pathlib import Path
from time import time

file = Path("/path/to/latest-export.csv")

if not file.exists() or time() - file.stat().st_mtime > 86400:
    print("Export alert: the latest file is missing or over 24 hours old.")
```

![Editar una tarea de script recurrente para comprobar una exportación ausente u obsoleta](../images/scheduled-task-script-2.png)

Sustituya la ruta de ejemplo por la ubicación real de la exportación.
Si el archivo existe y es reciente, el script termina sin enviar un mensaje innecesario.

## Actualizarme directamente en IM

LightVela le permite conectar su Agent a WhatsApp, Telegram, WeChat, Discord y más mediante su [configuración de canales](https://lightvela.ai/docs/configuration?from=social_x).
Puede conectar uno o varios canales al mismo tiempo.
En Tareas programadas, puede activar cada canal configurado para decidir dónde deben entregarse las alertas del script.

![Una tarea de script envía directamente en Telegram el resultado de una comprobación de uso de disco](../images/scheduled-task-script-3.png)

Cuando el script produce una salida estándar no vacía, Hermes envía esa salida directamente a su IM.
Si el script no imprime nada, la tarea termina sin enviar una notificación.

## Gestionar varias tareas

Puede crear tantas tareas programadas como necesite.
Después de crearlas, puede editar sus scripts y programaciones, pausarlas y consultar ejecuciones anteriores.
Pruebe cada script antes de programarlo, especialmente si accede a archivos importantes.

![Lista de trabajos actuales con tareas de script](../images/scheduled-task-script-4.png)

Con LightVela, su Hermes Agent personal puede encargarse continuamente de comprobaciones predecibles mientras usted se concentra en otro trabajo.
