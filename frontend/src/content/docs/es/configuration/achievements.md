# Achievements

## Resumen

**La página Achievements muestra el progreso de uso del Hermes Agent del Bot actual. Resume los achievements desbloqueados, descubiertos y secretos, el nivel más alto alcanzado, y el estado, la categoría, el progreso, la regla de conteo y la sesión de origen de cada tarjeta cuando existe.** Úsala para volver a escanear el historial de Hermes del Bot actual y comprobar si se reconocieron el uso de herramientas, depuración, configuración de modelos, memoria, Skills, documentación y automatizaciones.

![Página Achievements con tarjetas de estadísticas, filtros de estado, filtros de categoría y tarjetas de achievements](../../images/achievements-overview.webp)

---

Los achievements no se configuran manualmente. LightVela los genera a partir del comportamiento histórico del Hermes Agent del Bot actual. Sirven para entender qué capacidades del Agent ya exploraste y si el módulo de achievements leyó el historial más reciente.

Si estás empezando con LightVela, prueba primero flujos básicos como [Chat del Agent](./agent-chat.md), [Configurar Skills](./skill.md), [Gestión de la memoria](./memory.md) o [Tareas programadas](./automation.md), y luego vuelve a Achievements para revisar el progreso.

## Antes de empezar

1. Inicia sesión en LightVela y asegúrate de tener al menos un Hermes Agent activo.
2. Abre la consola del Bot que quieres revisar.
3. Para ver progreso útil, el Bot debería tener conversaciones reales, llamadas a herramientas, cambios de configuración o actividad de tareas programadas.

Los achievements se leen por Bot. Si cambias a otro Bot, el snapshot y el progreso pueden ser distintos.

## Abrir Achievements

1. Inicia sesión en LightVela.
2. Abre la consola My Hermes.
3. Selecciona Achievements en la navegación de configuración.
4. Espera a que la página lea el historial de Hermes del Bot actual.

Cuando termine la carga, la página mostrará tarjetas de estadísticas, filtros de estado y categoría, y la cuadrícula de achievements.

## Leer las estadísticas

La parte superior muestra cuatro estadísticas:

| Estadística | Significado |
| --- | --- |
| Desbloqueados | Achievements cuyos requisitos ya se completaron, comparados con el total visible actual. |
| Descubiertos | Achievements que ya tienen progreso pero todavía no están desbloqueados. |
| Secretos | Achievements cuyos requisitos exactos permanecen ocultos hasta que aparece el comportamiento relacionado. |
| Nivel más alto | El nivel más alto alcanzado por el Bot actual. El orden es Copper, Silver, Gold, Diamond y Olympian. |

Si la página indica que se está leyendo el historial de Hermes, el módulo de achievements aún está escaneando sesiones. Espera a que termine antes de tomar las cifras como definitivas.

## Filtrar achievements

Usa los dos filtros debajo de las estadísticas:

1. **Filtro de estado**: muestra todos, desbloqueados, descubiertos o secretos.
2. **Filtro de categoría**: filtra categorías como Agent Autonomy, Debugging Chaos, Vibe Coding, Hermes Native, Research/Web, Tool Mastery, Model Lore y Lifestyle.

Si no aparece ningún resultado, vuelve a seleccionar todos en ambos filtros. Si la lista sigue vacía, vuelve a escanear el historial del Bot actual.

## Leer una tarjeta

Cada tarjeta puede incluir estos campos:

| Campo | Significado |
| --- | --- |
| Nombre y descripción | El comportamiento de Hermes Agent que representa el achievement. Los secretos se muestran como secretos hasta ser descubiertos. |
| Estado | Desbloqueado, descubierto o secreto. |
| Nivel | Los achievements por nivel pueden mostrar Copper, Silver, Gold, Diamond u Olympian. |
| Progreso | Progreso actual, siguiente umbral o porcentaje. Los secretos muestran requisitos ocultos. |
| Regla de conteo | Despliega la regla para ver qué se cuenta, como llamadas a herramientas, revisión de logs, configuración de modelos o actividad de documentación. |
| Sesión de origen | Algunos achievements muestran el título de la sesión que aportó evidencia al progreso. |

Las reglas de conteo vienen del historial de Hermes Agent. Si una tarjeta indica que no se devolvió una regla, significa que no hay texto de regla para mostrar en esa tarjeta; no implica necesariamente que el achievement no pueda desbloquearse.

## Volver a escanear

Si acabas de completar conversaciones, llamadas a herramientas o cambios de configuración y la página no cambió, vuelve a escanear:

1. Abre Achievements.
2. Haz clic en el botón de reescaneo de la esquina superior derecha.
3. Espera a que el botón deje de girar o desaparezca el mensaje de lectura de historial.
4. Comprueba si cambiaron las estadísticas o las tarjetas relacionadas.

El reescaneo lee el historial de Hermes del Bot actual. Los Bots con historiales largos pueden tardar más.

## Verificar que el progreso se reconoció

Después de completar una acción real, usa esta lista:

1. En el Bot actual, realiza una acción contable, como revisar logs, usar herramientas, cambiar configuración de modelo, ejecutar una tarea programada o mantener documentación.
2. Vuelve a Achievements y reescanea.
3. Selecciona Descubiertos o Desbloqueados en el filtro de estado.
4. Abre la regla de conteo de la tarjeta relacionada y comprueba si cambió el progreso, el porcentaje o la sesión de origen.

Si no hay cambios, confirma primero que la acción ocurrió en el mismo Bot que estás viendo.

## FAQ

### ¿Por qué el achievement no cambió justo después de usar una función?

La página lee un snapshot de historial del Bot actual. Tras actividad reciente, puede que necesites reescanear. Los historiales grandes también pueden tardar más.

### ¿Por qué hay achievements secretos?

Los requisitos secretos aparecen después de que Hermes Agent detecta el comportamiento relacionado. Sigue usando Hermes Agent en depuración, herramientas, memoria, Skills, plugins, configuración de modelos y automatización.

### ¿Por qué falló la carga de achievements?

Las causas comunes son que Hermes Agent no esté disponible temporalmente, un fallo de análisis o un fallo del comando de achievements. Actualiza o reintenta primero. Si continúa, usa [Diagnóstico](./diagnostics.md) para revisar el estado del servicio y los logs.

### ¿Por qué cambiaron los achievements al cambiar de Bot?

Los achievements se leen del historial del Bot actual. Distintos Bots tienen conversaciones, herramientas, memoria, Skills e historial de configuración de modelos distintos.

### ¿Los achievements afectan mi plan, créditos o permisos?

No. Solo muestran progreso de uso. No cambian el plan, los créditos de IA, la cuota de Bots ni los permisos. Para facturación, consulta [Planes](../plans.md) y [Créditos](../credits.md).
