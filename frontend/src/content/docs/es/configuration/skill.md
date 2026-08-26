# Configurar Skills

## Resumen

**Las Skills son paquetes de capacidades complementarias que su Hermes Agent puede llamar, extendiendo su funcionalidad más allá de una conversación básica hacia tareas concretas como organizar tareas pendientes, generar informes diarios, navegar por la web, buscar noticias y generar imágenes. Proviene de Skills.sh y ClawHub, los mercados de Skills compartidos por OpenClaw y Hermes. Las Skills son opcionales: un Agent se envía sin ninguna instalada y aún conversa normalmente, por lo que el enfoque recomendado es instalar una solo después de alcanzar un límite de capacidad. Hay dos formas de instalar: buscar por nombre en la sección Skills de la consola, o simplemente pedir al Agent que la instale en la conversación. Las Skills instaladas pueden eliminarse desde la consola.**

---

Las Skills son paquetes de capacidades adicionales llamables por Hermes. Extienden el manejo de tareas concretas más allá de una conversación básica, como organizar automáticamente tareas pendientes, generar informes diarios, navegar por páginas web, buscar noticias, generar imágenes y más.

Todas las Skills provienen de [**Skills.sh**](https://skills.sh/) y [**ClawHub**](https://clawhub.ai/) — los mercados de Skills compartidos por OpenClaw y Hermes.

## Esta página cubre

- Relación entre Hermes y Skills
- Dos métodos de instalación: instalación por consola e instalación por conversación
- Ejemplos de uso de Skills
- Eliminación de Skills instaladas
- Preguntas frecuentes

> 💡 **Las Skills son opcionales**
>
> Hermes no instala ninguna Skill por defecto. Hermes aún puede conversar normalmente sin Skills instaladas. Las Skills solo se utilizan para extender capacidades específicas de tareas. Recomendamos instalarlas según sea necesario después de descubrir los límites de capacidad durante el uso.

---

## Posicionamiento de las Skills

Si Hermes junto con un modelo grande da a los usuarios un asistente de IA inteligente, las Skills son sus "manos y pies". Las Skills pueden extender aún más el límite de capacidad de un Hermes ya desplegado.

Puede pensar en las Skills como "aplicaciones" para Hermes:

- Capacidad de conversación básica = sistema operativo
- Skills = aplicaciones instaladas a demanda

Cada Skill se centra en una sola tarea, por ejemplo:

- Navegar por páginas web y consultar información con un navegador
- Organizar automáticamente tareas diarias
- Enviar notificaciones de noticias programadas
- Generar imágenes a partir de descripciones
- Consultar información de acciones y fondos en tiempo real
- Organizar registros de chat en notas estructuradas

Hermes determina automáticamente si debe llamar a la Skill correspondiente basada en el contexto de la conversación. Los usuarios no necesitan especificarla.

---

---

## Método 1: Instalar a través del panel de consola (próximamente)

La consola LightVela proporciona una entrada visual de configuración de Skills en el botón "Skills". Puede ingresar el nombre de una Skill encontrada en Skills.sh o ClawHub e instalarla rápidamente.

### 1. Iniciar sesión en la consola LightVela

Inicie sesión en LightVela, haga clic en "Mis socios de IA" en la esquina superior derecha para entrar a la consola y encuentre el botón "Skills".

### 2. Buscar e instalar

Ingrese el nombre de la Skill registrada en la caja de búsqueda (como `gmail`) y haga clic en el botón **+**.

![](../images/clawhub-install-global-en.webp)

### 3. Confirmar disponibilidad en la conversación

Vuelva a un canal conectado (Telegram / WhatsApp / Discord / Slack / WeChat). Primero pida a Hermes que actualice su lista de Skills, luego verifique las Skills actualmente disponibles:

```
Please update your skill list
```

```
What skills are currently available?
```

Si la Skill recién instalada aparece en la lista, puede comenzar a utilizarla en la conversación.

---

## Método 2: Instalar directamente a través de la conversación

Además de usar el panel de consola, también puede pedirle a Hermes que instale una Skill directamente a través de la conversación. La Skill a instalar aún debe estar listada en Skills.sh o ClawHub.

### 1. Confirmar que el canal de conversación está disponible

Primero asegúrese de que Hermes esté conectado al menos a un canal (Telegram / WhatsApp / Discord / Slack / WeChat) y pueda conversar normalmente actualmente.

### 2. Indicar a Hermes qué Skill instalar

Use el siguiente comando como referencia. Indique a Hermes qué Skill desea instalar y reemplace `[nombre de Skill]` con el nombre real de Skills.sh o ClawHub:

```
Please install a skill from Skills.sh or ClawHub. Its name is [skill name]
```

Por ejemplo, para instalar `mcd` (asistente de McDonald's):

```
Please install a skill from Skills.sh or ClawHub. Its name is mcd
```

Si todo va bien, Hermes completará la instalación directamente y le informará del resultado.

> ⚠️ **Confirmación secundaria para Skills de alto riesgo**
>
> Si la Skill seleccionada está marcada como de alto riesgo en Skills.sh o ClawHub (puede contener comportamientos inseguros), Hermes le recordará y solicitará una confirmación secundaria antes de la instalación. Asegúrese de comprender completamente el comportamiento de la Skill antes de decidir continuar. Si está en duda, proceda con precaución.

### 3. Verificar el resultado de la instalación

Puede pedirle a Hermes que muestre cómo usar la Skill para verificar que la instalación fue exitosa:

```
Please show me how to use it
```

O especifique el nombre de la Skill explícitamente:

```
Please show me how to use mcd
```

---

## Ejemplos de uso de Skills

Como ejemplo, utilizando la Skill `agent-browser` de operación de navegador, después de la instalación puede pedirle a Hermes que realice las siguientes tareas.

> ℹ️ **Nota**
>
> Los siguientes ejemplos utilizan el canal WeChat. Telegram, WhatsApp, Discord y Slack funcionan de la misma manera.

### Escenario 1: Navegar por una página web

```
Use the browser to visit Baidu and tell me what is on the page
```

Hermes abre la página y devuelve el contenido en formato de texto.

### Escenario 2: Buscar información a través del navegador

```
Use the browser to look up today's top 5 trending news stories
```

### Escenario 3: Tarea compleja de múltiples pasos

```
Use the browser to search ClawHub and find the currently most-installed email skill
```

Esta tarea incluye múltiples pasos como abrir una página web, esperar a que cargue, ingresar contenido y hacer clic en botones. Es relativamente compleja. Hermes completa los pasos y devuelve el resultado.

![](../images/clawhub-browser-example-global-en.webp)

---

## Eliminar Skills instaladas

Si ya no utiliza una Skill instalada, puede pedirle a Hermes que la elimine a través de la conversación.

### 1. Verificar Skills instaladas actualmente

```
What skills do you currently have installed?
```

### 2. Solicitar eliminación de una Skill específica

Encuentre la Skill que desea eliminar y envíe un comando de eliminación:

```
Please delete the email skill
```

Si todo va bien, Hermes completará la eliminación y le informará del resultado.

> ℹ️ **Confirmación secundaria posible**
>
> Dependiendo del modelo utilizado o de la configuración de personalidad de Hermes, puede recordarle tener cuidado al eliminar. Responda con confirmación según sus necesidades reales.

### 3. Verificar el resultado de la eliminación

Verifique nuevamente las Skills instaladas actualmente y confirme que la Skill objetivo haya sido eliminada de la lista:

```
Check again what skills you currently have installed
```

> ℹ️ **Actualmente solo se soporta eliminación basada en conversación**
>
> LightVela utiliza un modo alojado en la nube y no proporciona operaciones de sistema de archivos para el usuario. Las Skills solo pueden eliminarse a través de la conversación con Hermes.

---

## Estado de éxito

- La Skill objetivo aparece en la lista "Skills instaladas" en la consola
- Cuando realiza una solicitud relacionada en la conversación, Hermes puede reconocer y llamar correctamente la Skill
- La Skill puede eliminarse normalmente a través de la conversación


---

## Consejos de seguridad de instalación

Las Skills tienen permiso para llamar capacidades de Hermes en tiempo de ejecución y pueden involucrar:

- Llamar a APIs externas (consumo del cuot correspondiente)
- Leer o enviar contenido de conversación
- Ejecutar operaciones programadas

Antes de la instalación, confirme que el autor de la Skill sea confiable. Recomendamos:

- Prefiera Skills oficialmente verificadas en Skills.sh o ClawHub
- Prefiera Skills con muchas descargas y buenas reseñas
- Lea cuidadosamente la descripción de permisos en la descripción de la Skill
- Manténgase cauteloso con Skills que tengan descripciones poco claras o autores desconocidos


---

## Preguntas frecuentes

### No puedo encontrar una Skill

**Causa posible**: El nombre está mal escrito, o la Skill ha sido eliminada de Skills.sh o ClawHub.

**Solución**: Vaya a [**Skills.sh**](https://skills.sh/) o [**ClawHub**](https://clawhub.ai/) para confirmar el nombre exacto de la Skill y su estado actual.

### Instalación exitosa pero no toma efecto en la conversación

**Causa posible**: El modelo no reconoció que debería usar la Skill, o la lista de Skills no se ha actualizado.

**Solución**:

1. Envíe "Please update your skill list" en la conversación
2. Use una instrucción más clara, como "Use the XX skill to complete YY"


### Instalación dice "límite de tasa alcanzado, por favor intente de nuevo más tarde"

**Causa posible**: Skills.sh y ClawHub aplican límites de tasa de API para proteger la estabilidad del servicio.

**Solución**: Espere un poco e intente de nuevo. Recomendamos evitar horas pico.

### Las llamadas de Skill continúan fallando

**Causas posibles**:

- Los servicios externos requeridos por la Skill están temporalmente no disponibles
- La versión de la Skill está desactualizada
- El modelo correspondiente no soporta las capacidades requeridas por la Skill, como la llamada de herramientas


**Solución**:

- Revise los comentarios y la información de la versión más reciente de la Skill en Skills.sh o ClawHub
- Intente cambiar a un modelo que soporte llamadas de herramientas
- Si el problema persiste, contacte al autor de la Skill


### Demasiadas Skills instaladas hacen que Hermes responda lentamente

**Causa posible**: Más Skills aumentan la carga de decisión del Agent.

**Solución**: Mantenga solo las Skills comúnmente utilizadas y elimine las que ya no utiliza.

### Cómo desarrollar Skills

Vea la documentación de desarrollador de Skills.sh y ClawHub (si está disponible).

---

## Próximos pasos

La configuración básica de LightVela está completa. Puede consultar:

- [Resumen de configuración](../05-configuration.md)
- [Conceptos principales](../04-core-concepts.md)
- [Inicio rápido](../02-quickstart.md)
