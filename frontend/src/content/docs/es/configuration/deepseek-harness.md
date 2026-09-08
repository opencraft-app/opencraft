# DeepSeek Harness

## Resumen

**DeepSeek Harness es un framework de AI Agent con una arquitectura basada en plugins que puede instalar junto a Hermes Agent en LightVela. La página de Labs gestiona la instalación, el estado, el reinicio, el acceso a WebUI, las claves de los proveedores de modelos compatibles y un perfil con SkillHub, sin cambiar la configuración, los canales, las Skills ni la memoria existentes de Hermes. Para configurar los proveedores de modelos utilizados por Hermes Agent, consulte [Configurar modelos](./model.md).**

![Resumen de DeepSeek Harness](../images/deepseek-harness-01.png)

Aviso de Beta: DeepSeek Harness es una función de Labs en acceso anticipado.
Las actualizaciones futuras pueden introducir cambios de compatibilidad a medida que evolucionen el framework upstream y su ecosistema de plugins.

## Qué añade DeepSeek Harness

DeepSeek Harness (DSH) es un agent harness de código abierto que proporciona a los modelos de IA el entorno y las herramientas que necesitan para trabajar en tareas reales.
En LightVela, DSH se ejecuta como un entorno gestionado independiente junto a Hermes Agent, donde puede trabajar con archivos del proyecto, usar herramientas y Skills, administrar sesiones e interactuar con el Agent mediante su WebUI.

![Página de DeepSeek Harness en Labs](../images/deepseek-harness-02.png)

LightVela proporciona un punto de entrada gestionado para DSH.
No necesita instalar paquetes manualmente, configurar una dirección de servidor pública ni operar el servicio DSH desde un terminal.
Desde la página de DeepSeek Harness en Labs, puede instalar el runtime gestionado, comprobar si está saludable, configurar un proveedor de modelos aprobado, abrir la WebUI específica de su instancia y reiniciar DSH cuando sea necesario.

## Instalar DeepSeek Harness

1. Abra la [página de Agents de LightVela](https://lightvela.ai/agents/).
2. En la navegación izquierda, vaya a Labs y seleccione DeepSeek Harness.
3. Revise el aviso de Beta y seleccione Install and try now.
4. Mantenga la página abierta mientras se ejecuta la instalación.
   Una instalación normal suele tardar entre uno y tres minutos.

![Instalar DeepSeek Harness](../images/deepseek-harness-03.png)

## Configurar un proveedor de modelos

Después de instalar DeepSeek Harness, la tarjeta Model Configuration estará disponible debajo de la tarjeta principal de DSH.
Para el sitio internacional, la lista de proveedores aprobados actualmente incluye:

- DeepSeek
- MiniMax
- MiniMax China
- Moonshot AI
- Moonshot AI China
- OpenRouter
- Anthropic
- Groq
- OpenAI

Para añadir un proveedor:

1. Seleccione un proveedor en la lista.
2. Pegue su API key en el campo API Key.
3. Seleccione Save.
4. Confirme que el proveedor aparece en la lista de proveedores configurados.

![Formulario de proveedor de modelos de DeepSeek Harness](../images/deepseek-harness-04.png)

Para eliminar un proveedor, seleccione la acción de eliminación y confirme la operación.
Después de eliminarlo, puede volver a añadir el mismo proveedor más adelante con una API key nueva.

![Proveedor de DeepSeek Harness configurado](../images/deepseek-harness-05.png)

## Abrir la WebUI de DeepSeek Harness

Cuando el estado del servicio sea running, seleccione Access WebUI en la tarjeta de DeepSeek Harness.

![Botón Access WebUI](../images/deepseek-harness-06.png)

LightVela proporciona un dominio de acceso dedicado y autenticación de identidad integrada para la WebUI de DeepSeek Harness, de modo que solo usted pueda acceder a ella.
Una vez autenticado, puede abrir la WebUI de su instancia de Agent actual y comenzar con una prueba sencilla usando un proveedor que ya haya configurado.
Si necesita probar Hermes Agent por separado, use [Chat](./agent-chat.md).

![WebUI de DeepSeek Harness](../images/deepseek-harness-07.png)

## Entender los plugins

DeepSeek Harness utiliza una arquitectura basada en plugins.
Un plugin proporciona una capacidad o integración a un perfil de DSH, como un catálogo de Skills, un conector de mensajería u otro componente de runtime.
Puede visitar Plugin Plaza haciendo clic en Plugin Plaza en la esquina inferior izquierda de la página de DSH.

### Instalar y usar un plugin

Desde Plugin Plaza, puede explorar capacidades adicionales para su entorno de DeepSeek Harness, como herramientas de navegador, memoria, tarea programada, mejoras de UI e integraciones externas.

![Búsqueda de Plugin Plaza](../images/deepseek-harness-08.png)

Abra un plugin para revisar lo que añade y, después, instale los que quiera usar.
Después de instalar un plugin, puede utilizarlo directamente en el workspace sin mencionarlo explícitamente.
Para consultar las Skills de Hermes gestionadas por LightVela, vea [Configurar Skills](./skill.md).

### Examinar los plugins instalados

Puede ver la lista de plugins en DSH WebUI > Plugin Plaza > Installed.

![Plugins instalados de DeepSeek Harness](../images/deepseek-harness-09.png)

## Usar un workspace

Un workspace es el directorio del proyecto con el que DeepSeek Harness trabaja durante sus sesiones.
En la WebUI, haga clic en el icono Add Workspace para abrir el directorio del workspace.

![Icono Add Workspace](../images/deepseek-harness-10.png)

Después de seleccionarlo, puede crear una carpeta nueva o elegir una carpeta existente de su entorno DSH alojado en la nube y establecerla como workspace del proyecto.
El Agent podrá usar los archivos de ese workspace para comprender el proyecto, editar archivos, ejecutar comandos y realizar tareas dentro de ese workspace en la nube.

![Diálogo Select Workspace Directory](../images/deepseek-harness-11.png)

Los workspaces también ayudan a mantener organizados los proyectos y las sesiones.
Las sesiones creadas para un workspace se asocian a ese directorio, por lo que puede volver al mismo proyecto y continuar trabajando con su historial de sesiones relacionado.
Las operaciones que requieren permisos adicionales siguen sujetas a la política de permisos activa de DSH y pueden pedirle aprobación en la WebUI.
Para administrar archivos de LightVela fuera de DSH, consulte [Almacenamiento en la nube](./files.md).

## Reiniciar DeepSeek Harness

Use Restart cuando DSH esté instalado pero necesite volver a cargar después de un cambio de configuración, o cuando deba recuperarse de un estado no saludable.
La acción de reinicio solo se aplica al servicio DeepSeek Harness.
Hermes Agent continúa ejecutándose de forma independiente.

![Botón Restart de DeepSeek Harness](../images/deepseek-harness-12.png)

## Problemas comunes

| Síntoma | Causa probable | Qué hacer |
| --- | --- | --- |
| La instalación no termina | Una tarea de instalación gestionada no finalizó correctamente | Revise el error de la página, espere un momento y vuelva a intentarlo desde la página de DeepSeek Harness. |
| La WebUI no se abre | El servicio no está listo o la sesión actual no tiene acceso a la instancia | Confirme que DSH muestra el estado running y vuelva a abrir la WebUI desde Labs con la sesión iniciada. |
| Un modelo no puede responder a las solicitudes | No hay ningún proveedor configurado, la clave no es válida o la cuenta del proveedor no está disponible | Compruebe la lista de proveedores configurados, actualice la API key si es necesario y vuelva a realizar una solicitud sencilla. |
| Una API key guardada no es visible | Es el comportamiento esperado | Las API keys son de solo escritura. Deje el campo vacío para conservar la clave guardada o introduzca una nueva para reemplazarla. |
| Un canal no está conectado | El plugin existe, pero la configuración de su cuenta está incompleta | Configure y autorice el canal dentro de la WebUI de DSH. |
| DSH parece no saludable después de un cambio | Es posible que el servicio necesite volver a cargarse | Use Restart, espere al estado running y vuelva a validar la WebUI y el proveedor. |

## Límites actuales

DeepSeek Harness en LightVela está diseñado como una capacidad gestionada de Labs.
Proporciona instalación, estado, reinicio, credenciales de proveedores aprobados y un punto de entrada controlado a la WebUI.

La página de Labs actualmente no admite la instalación arbitraria de paquetes, la carga de plugins personalizados, el acceso directo a puertos de red, endpoints de proveedores personalizados, protocolos de proveedores personalizados ni la edición avanzada de parámetros de modelos.
Estos límites mantienen la instancia gestionada predecible mientras la función sigue en Beta.

Use DeepSeek Harness cuando quiera explorar su entorno de Agent basado en plugins, la integración con SkillHub y los componentes de canal compatibles sin cambiar la configuración existente de Hermes Agent.

## Preguntas frecuentes

### ¿DeepSeek Harness sustituye a Hermes Agent?

No.
Se ejecuta como un servicio independiente junto a Hermes.
La memoria, las Skills, los canales y la configuración existentes de Hermes permanecen sin cambios.

### ¿Por qué no puedo ver mi API key guardada?

Las API keys son de solo escritura.
Deje el campo vacío para conservar la clave existente o introduzca una nueva para reemplazarla.

### ¿Puedo añadir cualquier proveedor, modelo o Base URL personalizada?

La página de Labs de LightVela actualmente solo admite los proveedores que aparecen en su selector.
Para configuraciones de modelos adicionales, incluidos modelos personalizados o Base URLs, puede gestionarlas directamente desde la WebUI de DeepSeek Harness.

### ¿Las Skills de DeepSeek Harness son las mismas que las de Hermes?

No.
DeepSeek Harness y Hermes Agent son entornos independientes.
Instalar DeepSeek Harness no copia automáticamente las Skills de Hermes a DSH, y la configuración de plugins o Skills de DSH no cambia la configuración de Hermes Agent.

### ¿Por qué DeepSeek Harness aparece marcado como Beta?

Es una función de Labs en acceso anticipado.
Las actualizaciones de DSH o de sus plugins pueden introducir cambios de compatibilidad, así que valide su flujo de trabajo después de las actualizaciones.
