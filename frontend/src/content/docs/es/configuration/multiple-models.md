# Cambio de modelo

## Resumen

**El cambio de modelo le permite elegir qué modelo configurado utiliza actualmente el Hermes Agent. Cuando una tarea requiere diferentes velocidades, capacidades, perfiles de costo o disponibilidad del proveedor, cambie de modelo en lugar de crear un nuevo Agent. Esto funciona porque la personalidad, la memoria, las Skills y las tareas automatizadas se almacenan fuera del modelo, por lo que cambiar de modelo solo cambia el motor de razonamiento — nada se elimina ni se borra, y el Agent sigue recordando a usted. Cada Agent tiene exactamente un modelo activo a la vez.**

---

El cambio de modelo le permite elegir qué modelo configurado utilizará su Hermes Agent para su próxima tarea. Cambie cuando una tarea necesite un equilibrio diferente de velocidad, capacidad, costo o disponibilidad del proveedor, sin crear un nuevo Agent.

## Lo que cubre esta página

- Preparar más de un modelo utilizable
- Seleccionar el modelo activo para un Agent
- Verificar el cambio en Chat
- Solucionar problemas con un modelo que no aparece o no puede responder

> **Bueno para saber:** Un Agent utiliza un modelo activo a la vez. Cambiar el modelo activo no elimina la memoria del Agent, los archivos de Almacenamiento en la nube, las Skills o las automatizaciones.

## Antes de comenzar

1. Abra el Agent que desea actualizar.
2. Asegúrese de que el modelo objetivo ya haya sido configurado y esté disponible para su cuenta. Si no es así, siga [Configurar modelos](./model.md) primero.
3. Mantenga una breve instrucción de prueba lista para confirmar que el nuevo modelo responde como se espera.

## Cambiar el modelo activo

1. Abra **Agents** y seleccione el Agent.
2. Abra la sección **Modelos**.
3. Elija el modelo configurado que desea que utilice el Agent.
4. Guarde o aplique el cambio, luego espere a que el Agent termine de actualizar su configuración activa.

![El selector de proveedor de modelo en la consola de LightVela](../images/4-1-en.webp)

Si está eligiendo un modelo por primera vez, utilice [Configurar modelos](./model.md) para agregar un proveedor compatible o un modelo personalizado antes de volver aquí.

## Verificar el cambio

Abra [Chat](./agent-chat.md) y envíe una breve instrucción de bajo riesgo, por ejemplo:

```text
Reply with the name of the current model if it is available, then summarize this sentence in one line: Model switching is ready.
```

Confirme que el Agent responda normalmente y que el modelo mostrado en la consola del Agent sea el uno que seleccionó. Si la primera respuesta tarda un poco más mientras el Agent se actualice, espere brevemente e intente una vez antes de realizar otro cambio.

## Elegir el momento adecuado para cambiar

| Situación | Lo que considerar |
| --- | --- |
| Necesita un borrador rápido | Elija un modelo configurado que se adapte a tareas cortas y rutinarias. |
| Una tarea necesita razonamiento más fuerte o ayuda de código | Elija un modelo que haya configurado para ese tipo de trabajo. |
| Un proveedor no está disponible o tiene límites de tasa | Cambie a otro modelo configurado, luego pruébelo en Chat. |
| Está comparando la calidad de la salida | Ejecute la misma pequeña instrucción después de cada cambio y compare el resultado. |

El cambio de modelo cambia el motor utilizado para futuras respuestas. No mueve su historial de conversación, no reescribe archivos en [Almacenamiento en la nube](./files.md) ni cambia sus [Skills](./skill.md) y [Automatizaciones](./automation.md).

## Si un cambio no funciona

1. Vuelva a [Configurar modelos](./model.md) y confirme que la configuración del modelo objetivo, las credenciales y la configuración del proveedor estén completas.
2. Confirme que el modelo está disponible para su cuenta y tenga suficiente cuota o créditos del proveedor.
3. Seleccione un modelo que funcione conocido y pruébelo en Chat.
4. Si el Agent aún no puede responder, abra [Diagnósticos](./diagnostics.md) y revise los registros recientes antes de reiniciar su configuración de modelo.

> **Consejo:** Cambie una cosa a la vez. Probar después de cada cambio hace que sea mucho más fácil determinar si el problema es el modelo, su configuración o la tarea en sí.

## Preguntas frecuentes

### ¿Por qué no aparece el modelo que quiero?

Solo se pueden seleccionar modelos configurados. Agregue o complete el modelo en [Configurar modelos](./model.md), luego vuelva a la sección de Modelos.

### ¿El cambio de modelos borra la memoria de mi Agent?

No. El modelo activo cambia, mientras que la memoria del Agent y la configuración guardada permanecen en su lugar. Puede revisar la memoria por separado en [Memoria](./memory.md).

### ¿Puedo volver atrás si no me gusta el resultado?

Sí. Seleccione otro modelo configurado, aplique el cambio y pruébelo con la misma instrucción. Mantener la instrucción consistente le proporciona una comparación más útil.

## Próximos pasos

- Configure proveedores adicionales en [Configurar modelos](./model.md).
- Utilice [Chat](./agent-chat.md) para comparar las respuestas del modelo en una tarea real.
- Utilice [Diagnósticos](./diagnostics.md) si un modelo configurado falla repetidamente al iniciar.
