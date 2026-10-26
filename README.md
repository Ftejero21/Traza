<h1 align="center">Traza</h1>

<p align="center">
  <strong>Pregunta cómo funciona algo de tu proyecto y míralo pasar, paso a paso, por tu propio código.</strong><br>
  Diagramas de secuencia animados, simulación de datos, análisis de logs, mapa de base de datos y simulación de cambios,<br>
  con la IA que ya usas en VS Code.
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Ftejero21/nexo-vscode/main/media/chat-nexo.webp" alt="@traza genera el flujo del login desde el chat de VS Code" width="900">
</p>

---

## Qué hace

Escribe `@traza ¿cómo funciona el login?` y Traza lee el código relevante de tu proyecto, sigue la petición de capa en capa (frontend → API → servicio → base de datos) y te abre un panel con el recorrido completo. Cada paso apunta a su `archivo:línea` real.

| | |
|---|---|
| ▶️ **Recorrido** | Diagrama de secuencia animado, con el código de cada paso al lado y salto directo al editor. |
| 🧪 **Simular datos** | Elige un escenario («contraseña incorrecta», «usuario inexistente»…) y la IA recorre el flujo hasta el paso exacto donde falla, explicando por qué. |
| 🖥️ **Vista de pantalla** | Renderiza la pantalla real del componente para ver qué ve el usuario en ese caso, antes y después de un cambio. |
| 📜 **Analizar logs** | Pega los logs de una ejecución y Traza señala en qué paso del flujo se rompió. |
| 🗄️ **Base de datos** | Qué tablas y columnas se leen o escriben en cada paso, con el esquema real si conectas tu BD. |
| 🔀 **Simular cambios** | Revisa un cambio propuesto y compáralo antes y después en todos los escenarios: arreglos, mejoras y regresiones. |

Todo funciona **sin servidor propio**: la IA es el modelo que tengas configurado en VS Code (GitHub Copilot, Claude, GPT o tu propia clave).

---

## Empezar en 1 minuto

1. Abre tu proyecto en VS Code (funciona con varias carpetas a la vez, por ejemplo frontend + backend).
2. Asegúrate de tener un modelo de IA disponible (por ejemplo, con la sesión de GitHub Copilot iniciada).
3. En el chat escribe:

   ```
   @traza ¿cómo funciona el login?
   ```

4. La primera vez, elige el modelo y acepta el permiso de VS Code. Se abre el panel **Flujo · …**.

> 💡 Para cambiar de modelo: **Traza: Elegir modelo** en la paleta de comandos.

---

## El panel, pestaña a pestaña

### ▶️ Recorrido

<p align="center"><img src="https://raw.githubusercontent.com/Ftejero21/nexo-vscode/main/media/recorrido.webp" alt="Recorrido animado del login de FreeSocial" width="900"></p>

El flujo se reproduce paso a paso: quién llama a quién, con qué datos y en qué línea. Debajo ves el fragmento de código real del paso. Con **Abrir en el editor** saltas a esa línea. Puedes pausar, avanzar con ← y → o cambiar la velocidad (0,5× · 1× · 2×).

### 🧪 Simular datos

<p align="center"><img src="https://raw.githubusercontent.com/Ftejero21/nexo-vscode/main/media/simular-datos.webp" alt="Simulación de contraseña incorrecta que falla en el paso 7" width="900"></p>

Elige uno de los escenarios que propone la IA o edita el JSON de entrada y pulsa **Simular con estos datos**. El recorrido avanza hasta el paso donde el caso se detiene. La tarjeta de resultado explica:

- **dónde** falla (archivo, función y campo);
- **la conclusión de la IA**, con la cadena causal completa;
- **qué ve el usuario**;
- y una **propuesta de arreglo**.

En el ejemplo, una contraseña incorrecta en FreeSocial no termina en un aviso de «credenciales incorrectas». Acaba en un **HTTP 500**, porque el `catch` genérico se traga la excepción.

### 🖥️ Vista de pantalla

<p align="center"><img src="https://raw.githubusercontent.com/Ftejero21/nexo-vscode/main/media/vista-previa.webp" alt="Visualizar pantalla del componente de login, antes y con el cambio" width="900"></p>

Desde el menú de cualquier paso (pasa el ratón por su número) elige **Visualizar pantalla**. Traza reconstruye el componente real (plantilla y estilos) y marca lo que ve el usuario en ese escenario. Si hay un cambio propuesto, alterna entre **Ahora** y **Con el cambio**.

### 📜 Analizar logs

<p align="center"><img src="https://raw.githubusercontent.com/Ftejero21/nexo-vscode/main/media/analizar-logs.png" alt="Pestaña Analizar logs" width="900"></p>

Pega los logs del navegador o del servidor y pulsa **Analizar logs**. Traza cruza las trazas con los pasos del flujo, marca **● en logs** los pasos que aparecen y señala el que falla con las evidencias. Los datos sensibles se ocultan antes de enviarlos.

### 🗄️ Base de datos

<p align="center"><img src="https://raw.githubusercontent.com/Ftejero21/nexo-vscode/main/media/base-de-datos.webp" alt="Mapa de datos: SELECT y UPDATE sobre la tabla usuario" width="900"></p>

El diagrama de tablas se recorre al ritmo del flujo. En cada acceso ves la operación (`SELECT`, `UPDATE`…), las columnas y de dónde sale cada valor (`email ← usuarioDTO.email`). Sin conexión se deduce del código. Con una conexión configurada se usa **el esquema real**, del que solo se lee la metadata.

### 🔀 Simular cambios

<p align="center"><img src="https://raw.githubusercontent.com/Ftejero21/nexo-vscode/main/media/simular-cambios.webp" alt="Simular antes y después de un cambio propuesto" width="900"></p>

A la izquierda, el diff del cambio propuesto. A la derecha, **Simular cambios** ejecuta todos los escenarios antes y después y los clasifica en **arreglados**, **mejoran el aviso**, **sin cambios** y **regresiones**. **Simular antes y después** reproduce las dos versiones seguidas. **Aplicar** escribe el cambio en tus archivos solo cuando tú lo confirmas, y **Deshacer** lo revierte.

---

## Todas las formas de usarlo

### En el chat: `@traza`

- `@traza ¿cómo funciona el registro?` (o `@traza /flujo …`): genera el flujo y abre el panel.
- `@traza ¿qué ocurre si pongo una contraseña incorrecta?`: si la pregunta plantea un escenario, el chat muestra un resumen del escenario (qué ve el usuario, en qué paso y archivo falla, conclusión), una lista corta de pasos y el botón **Visualizar flujo**, que reabre ese flujo concreto (de los 10 últimos de la sesión). Traza busca en las carpetas que tengas abiertas en VS Code en ese momento; si la pregunta nombra una de ellas («… en *&lt;carpeta&gt;*»), solo usa esa.
- `@traza /cambio valida que el email no esté vacío`: propone un cambio sobre el flujo abierto y lo lleva a **Simular cambios**.
- Los archivos que adjuntes con `#archivo` se usan como pista prioritaria.

### En modo agente: `#trazaFlujo`

En el modo agente de Copilot, pregunta por un proceso («¿cómo funciona el pago?») y el agente llamará a Traza por su cuenta, o nómbralo con `#trazaFlujo`. VS Code pide confirmación (ahora también muestra la carpeta elegida), se abre el panel y el agente recibe los pasos en texto para su respuesta. La herramienta no modifica archivos.

- Se elige sola ante preguntas de escenario («¿qué pasa si…?», «what happens if…?»: contraseña incorrecta, sin sesión, sin permiso, registro inexistente…). El panel se abre en **Simular datos** con el escenario reproducido.
- La respuesta del agente termina con un enlace **Visualizar flujo** (`vscode://ftejero21.traza/show?id=…`) que se puede pulsar; VS Code puede pedir permiso para abrir la URI la primera vez.
- En un workspace con varias carpetas, el agente puede pasar `project` (o nombrarla en la pregunta) para limitar el análisis a esa carpeta.

### Copilot sin @traza

- Traza contribuye instrucciones a Copilot Chat para las preguntas sobre flujos y procesos del proyecto.
- En sesiones «Local» (modo Agent) Copilot puede llamar a `#trazaFlujo` aunque no escribas `@traza`.
- En otras sesiones (p. ej. Copilot CLI, donde las tools de extensiones pueden no estar disponibles) Copilot puede terminar la respuesta con un enlace «Visualizar flujo» (`vscode://ftejero21.traza/flow?q=…`) que genera el flujo tras pedir confirmación.
- Lo decide el modelo, así que no está garantizado al 100 %. Se desactiva con `traza.copilotInstructions: false`; en versiones de VS Code sin `chatInstructions` no se aplica.

### Desde un enlace

- Formato: `vscode://ftejero21.traza/flow?q=<pregunta codificada con encodeURIComponent>`, con `&mode=sim|logs|db` opcional (`db` abre Recorrido si no hay conexión a la base de datos).
- Ejemplo: `vscode://ftejero21.traza/flow?q=%C2%BFC%C3%B3mo%20funciona%20el%20login%3F&mode=sim`
- VS Code y Traza siempre piden confirmación antes de enviar código al modelo, y no se modifica ningún archivo. Solo se procesa un enlace a la vez.
- `vscode://ftejero21.traza/show?id=<id del flujo>`: reabre un flujo ya generado en la sesión actual (de los 10 últimos). No usa IA, no envía datos y no pide confirmación; si el id no está en la sesión, avisa de que hay que volver a generarlo.

### Comandos

| Comando | Qué hace |
|---|---|
| **Traza: Generar flujo** | Desde la paleta o con clic derecho en el editor. Usa el archivo activo y la selección como pista. |
| **Traza: Flujo** | Abre un `*.flow.json` (también con el botón Traza de la barra del editor). |
| **Traza: Proponer cambio** | Pide a la IA un cambio sobre el flujo abierto. |
| **Traza: Mostrar último flujo generado** | Vuelve a abrir el último flujo. |
| **Traza: Visualizar flujo** | Lo usan el botón del chat y el enlace `/show`; abre un flujo generado en la sesión (oculto en la paleta). |
| **Traza: Abrir flujo de ejemplo** | Un flujo de demostración para probar el panel. |
| **Traza: Elegir modelo** | Cambia el modelo de IA que usa Traza. |
| **Traza: Añadir / Contraseña / Probar / Quitar conexión de base de datos** | Gestiona conexiones PostgreSQL, MySQL o MariaDB para ver el esquema real. |

### Bases de datos

- Las conexiones se guardan en el ajuste `traza.databases`. Al añadir una, Traza propone los datos de tu `application.properties`, pero nunca lee la contraseña de ahí.
- La contraseña va al almacén seguro de VS Code (SecretStorage), nunca a los ajustes.
- Solo se lee metadata (tablas, columnas y claves) en modo solo lectura. Nunca se leen filas ni se ejecuta SQL generado por la IA.
- Sin TLS solo se admite `localhost`.

### Apariencia (`traza.theme`)

- `traza` (por defecto): paleta y fuentes originales de Traza, oscura o clara según el tema de VS Code.
- `vscode`: sigue los colores y fuentes del tema de VS Code.
- El cambio se aplica en caliente en el panel abierto, sin recargar.
- `nexo` es un alias antiguo de `traza` (cualquier valor distinto de `vscode` se trata como `traza`).

---

## Migración desde Nexo Flujo

Traza es el nuevo nombre de la extensión «Nexo Flujo» (id `ftejero21.traza`).

- Los ajustes `nexo.*` (`model`, `language`, `databases`, `theme`, `copilotInstructions`) se copian solos a `traza.*` la primera vez que se activa Traza, sin sobrescribir los `traza.*` que ya tengas. Los `nexo.*` antiguos no se borran.
- Las contraseñas de base de datos no se migran (el almacén seguro está aislado por extensión): vuelve a guardarlas con **Traza: Contraseña de base de datos**.
- `@nexo` pasa a `@traza` y `#nexoFlujo` a `#trazaFlujo`.
- Los enlaces `vscode://nexo-local.nexo-vscode/…` dejan de funcionar; usa `vscode://ftejero21.traza/…`.

---

## Requisitos

- **VS Code 1.95 o superior.** El modo agente requiere una versión de VS Code y de Copilot con herramientas de agente.
- **Un modelo de lenguaje en VS Code**: GitHub Copilot, Claude, GPT o BYOK. Se guarda en el ajuste `traza.model`; si está vacío, se elige al usarlo.
- **Una carpeta del proyecto abierta.**

---

## Privacidad

En cada operación, el código relevante se envía **al proveedor del modelo que elijas**, a través de VS Code.

**Se envía:** rutas de archivos, fragmentos de código relevantes, el archivo activo y la selección, el flujo, los datos de entrada, los logs que pegues y la metadata de la base de datos.

**No se envía nunca:**

- archivos sensibles (`.env`, `*.pem`, `*.key`, keystores, `id_rsa`…) ni archivos con claves privadas;
- dependencias, builds, lockfiles ni binarios;
- contraseñas de base de datos.

Además:

- Los secretos de configuración, tokens, contraseñas y emails se enmascaran como `«oculto»`.
- `#trazaFlujo` pide confirmación antes de enviar nada.
- El canal **Traza** del panel Output solo guarda diagnóstico (validaciones y modelos), nunca código, prompts ni respuestas.

## Consumo

Cada operación hace una o dos llamadas al modelo, más un reintento si la respuesta no es válida. **Simular cambios** hace dos llamadas por escenario (hasta 14). Esto consume cuota o *premium requests* de tu proveedor. Las respuestas se guardan en caché 15 minutos.

## Formato del JSON de flujo

Un `*.flow.json` tiene la forma `{ "flow": FlowDiagram, "proposals"?: [...] }`. También se acepta un `FlowDiagram` directo.

- `title`, `summary` y `errorSummary`;
- `lanes[]`: los participantes (`id`, `name`, `short`, `sub`, `kind`);
- `steps[]`: los pasos, con `from`, `to`, `label`, `kind`, `title`, `explanation` y `ref { file, line, anchor }`;
- `simulationPresets[]`: los escenarios de **Simular datos**.

Límites: 2 MB y 10 propuestas. Ejemplo completo: [samples/freesocial-login.flow.json](https://github.com/Ftejero21/nexo-vscode/blob/main/samples/freesocial-login.flow.json).

<p align="center"><sub>Las capturas son del proyecto de ejemplo FreeSocial (Angular + Spring Boot) con Claude a través de GitHub Copilot.</sub></p>
